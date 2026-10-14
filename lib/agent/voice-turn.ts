import {
  convertToModelMessages,
  extractReasoningMiddleware,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type UIMessage,
} from "ai";
import { getAgent, listAgentMembers } from "../db/agents";
import { createMessage, updateMessage } from "../db/conversations";
import { getDevice, insertDeviceEvent, type Device } from "../db/devices";
import { getUser } from "../db/users";
import { sendSpeech, stopSpeech } from "../devices/gateway";
import { publishLive } from "../devices/live";
import { withDeviceLock } from "../devices/lock";
import { deviceTimeZone, readDeviceSettings, type DeviceSettings } from "../devices/settings";
import { inQuietHours } from "../devices/speech-policy";
import { localDayLabel, localTime } from "../devices/time";
import { resolveVoice, synthesize } from "../devices/tts";
import { voiceSessions, type HeardTurn } from "../devices/voice/session";
import { SentenceSplitter, SilenceGate, heardBlock, speakable } from "../devices/voice/text";
import { applyCompaction, planChatCompaction, usageTokens } from "./compaction";
import {
  DEVICE_MEMORY_EXTRACTION_PROMPT,
  SILENT,
  buildDeviceTools,
  defaultDeviceRunDeps,
  deviceSystemPrompt,
  loadDeviceConversation,
  resolveRunModel,
  type DeviceRunDeps,
} from "./device-run";
import { inlineImageFileParts, windowImageParts } from "./image-parts";
import { buildMemorySystemPrompt, buildRelevantMemoriesBlock, type MemoryScope } from "./memory";
import { runMemoryExtraction } from "./memory-extraction";
import { withPromptCache } from "./prompt-cache";
import { stepsToUIMessageParts } from "./step-ui-messages";
import { loadSystemPrompt } from "./system-prompt";
import { deviceDescription } from "../devices/observation-tools";

// A voice turn (plan 4.11): what the device's microphone heard is appended to
// the device's conversation as a <heard> message; the agent replies, streamed,
// and each finished sentence is synthesised (Piper) and sent to the device,
// which plays the chunks back to back. A reply of exactly <silent/> is never
// spoken. New speech while the device talks interrupts it: the reply stops and
// the stored reply keeps only what was played.

const IMAGE_WINDOW = 2;
const MAX_STEPS = 4;

export type VoiceTurnStatus = "spoken" | "silent" | "interrupted" | "not_spoken" | "failed" | "no_agent" | "no_model";

export type VoiceTurnDeps = DeviceRunDeps & {
  synthesize: typeof synthesize;
  send: typeof sendSpeech;
  stop: typeof stopSpeech;
};

export const defaultVoiceTurnDeps: VoiceTurnDeps = {
  ...defaultDeviceRunDeps,
  synthesize,
  send: sendSpeech,
  stop: stopSpeech,
};

export type VoiceTurnMetadata = { voiceTurn: { at: string; speakers: string[] } };

/** The turn's model: the voice setting, else the agent run's. */
function voiceModelSettings(settings: DeviceSettings): DeviceSettings["agent"] {
  const v = settings.voice;
  return v.provider ? { ...settings.agent, provider: v.provider, model: v.model, route: v.route } : settings.agent;
}

/** Turn handler for voiceSessions: one turn at a time per device, ahead of agent runs. */
export function handleVoiceTurn(deviceId: string, turn: HeardTurn): void {
  executeVoiceTurn(deviceId, turn).catch((error) => console.error(`[voice] turn failed for ${deviceId}:`, error));
}

export function executeVoiceTurn(
  deviceId: string,
  turn: HeardTurn,
  deps: VoiceTurnDeps = defaultVoiceTurnDeps
): Promise<VoiceTurnStatus | null> {
  return withDeviceLock(deviceId, () => turnLocked(deviceId, turn, deps), true);
}

async function turnLocked(deviceId: string, turn: HeardTurn, deps: VoiceTurnDeps): Promise<VoiceTurnStatus | null> {
  const device = await getDevice(deviceId);
  if (!device) return null;
  const settings = readDeviceSettings(device.settings);
  const timeZone = deviceTimeZone(settings);
  const heard = heardBlock(`${localDayLabel(turn.at, timeZone)}, ${localTime(turn.at, timeZone, true)}`, turn.lines);
  const started = deps.now().getTime();
  const marks: Record<string, number> = { final: turn.finalAt - turn.speechEndAt };
  const mark = (name: string) => {
    marks[name] ??= Date.now() - turn.speechEndAt;
  };

  const record = async (status: VoiceTurnStatus, extra: Record<string, unknown> = {}) => {
    const event = await insertDeviceEvent(deviceId, "voice", {
      status,
      heard: turn.lines,
      audioMs: turn.audioMs,
      ms: deps.now().getTime() - started,
      latencyMs: marks,
      ...extra,
    });
    publishLive(deviceId, { type: "voice", event });
    return status;
  };

  if (!device.agentId) return record("no_agent");
  const agentId = device.agentId;
  // Everything the call needs, loaded in parallel: someone is waiting.
  const [agent, members, owner, runModel, conversation] = await Promise.all([
    getAgent(agentId),
    listAgentMembers(agentId),
    getUser(device.ownerId),
    deps.resolveModel(device, { ...settings, agent: voiceModelSettings(settings) }),
    loadDeviceConversation(deviceId, agentId),
  ]);
  if (!agent || !owner) return record("no_agent");
  if (!runModel) return record("no_model");
  const { current, history } = conversation;
  const conversationId = current?.id ?? crypto.randomUUID();
  const scope: MemoryScope | null = agent.memoryPoolId
    ? { agentId: agent.id, poolId: agent.memoryPoolId, speaker: { id: owner.id, name: owner.name }, members }
    : null;
  const memoryScope = agent.chatMemoryEnabled ? scope : null;
  const heardText = turn.lines.map((l) => l.text).join("\n");
  const [basePrompt, memoriesBlock, memorySystemPrompt] = await Promise.all([
    loadSystemPrompt(),
    memoryScope ? buildRelevantMemoriesBlock(memoryScope, heardText.slice(-2000)) : null,
    memoryScope
      ? buildMemorySystemPrompt(memoryScope, {
          sharedConversation: true,
          customPrompt: agent.chatMemoryPrompt,
          deviceName: device.name,
        })
      : "",
  ]);

  const metadata: VoiceTurnMetadata = {
    voiceTurn: { at: turn.at.toISOString(), speakers: [...new Set(turn.lines.map((l) => l.speaker))] },
  };
  history.push({
    id: crypto.randomUUID(),
    role: "user",
    metadata,
    parts: [...(memoriesBlock ? [{ type: "text" as const, text: memoriesBlock }] : []), { type: "text", text: heard }],
  });
  if (current) await updateMessage(conversationId, { messages: history });
  else
    await createMessage({
      id: conversationId,
      agentId: agent.id,
      userId: owner.id,
      shared: true,
      memory: true,
      deviceId,
      messages: history,
    });

  // Replies to someone who addressed the device skip the cooldown and hourly
  // cap (plan 4.11); mute and quiet hours still hold.
  const muted = settings.speech.muted;
  const quiet = inQuietHours(settings.speech.quietHours, deps.now(), timeZone);
  const language = mainLanguage(turn) ?? settings.speech.language;
  const { voice } = resolveVoice(settings.speech, language);
  const speaker = new ReplySpeaker(device, settings, voice, language, deps, () => mark("firstAudio"));

  const abort = new AbortController();
  let interrupted = false;
  const session = voiceSessions.get(deviceId);
  if (session) {
    session.reply = {
      speaking: () => speaker.speaking,
      interrupt: () => {
        interrupted = true;
        abort.abort();
        speaker.stop();
      },
    };
  }

  try {
    const system = deviceSystemPrompt({
      basePrompt,
      agentPrompt: agent.systemPrompt,
      memorySystemPrompt,
      deviceName: device.name,
      description: deviceDescription(device),
    });
    // No speak tool: the reply itself is spoken.
    const { speak: _speak, ...tools } = buildDeviceTools({
      device,
      settings,
      deps,
      memoryScope,
      conversationId,
      timeZone,
      agentId: agent.id,
      ownerId: owner.id,
    });
    const modelView = await inlineImageFileParts(
      windowImageParts(applyCompaction(history, current?.compaction ?? null), IMAGE_WINDOW),
      conversationId
    );
    const modelMessages = await convertToModelMessages(modelView, { tools, ignoreIncompleteToolCalls: true });
    mark("request");
    const result = streamText({
      model: wrapLanguageModel({
        model: runModel.model as Parameters<typeof wrapLanguageModel>[0]["model"],
        middleware: extractReasoningMiddleware({ tagName: "think" }),
      }),
      ...withPromptCache(system, modelMessages, runModel.provider === "anthropic"),
      tools,
      providerOptions: runModel.providerOptions,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: abort.signal,
    });

    const gate = new SilenceGate();
    const splitter = new SentenceSplitter();
    const canSpeak = !muted && !quiet;
    let replyText = "";
    try {
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          mark("firstToken");
          replyText += part.text;
          const open = gate.push(part.text);
          if (!open) continue;
          for (const sentence of splitter.push(open)) {
            mark("firstSentence");
            if (canSpeak) speaker.say(sentence);
          }
        } else if (part.type === "error") {
          throw part.error;
        }
      }
    } catch (error) {
      if (!interrupted) throw error;
    }
    gate.finish();
    if (gate.state === "speak") {
      const rest = splitter.flush();
      if (rest) {
        mark("firstSentence");
        if (canSpeak && !interrupted) speaker.say(rest);
      }
    }
    const played = await speaker.finish();

    const silent = gate.state === "silent";
    const spokenText = played.filter((p) => p.ok).map((p) => p.text).join(" ");
    const storedText = silent
      ? SILENT
      : interrupted
        ? `${spokenText}${spokenText ? " " : ""}[interrupted]`
        : speakable(replyText);
    let parts: UIMessage["parts"] = [{ type: "text", text: storedText }];
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
    if (!interrupted) {
      const steps = await result.steps;
      // The history keeps what was said, not stray markup (a "<speak>" in it gets copied by later turns).
      const stepParts = stepsToUIMessageParts(steps).map((part) =>
        part.type === "text" && !silent ? { ...part, text: speakable(part.text) } : part
      );
      if (stepParts.length) parts = stepParts;
      usage = steps.at(-1)?.usage ?? {};
    }
    const messages: UIMessage[] = [
      ...history,
      { id: crypto.randomUUID(), role: "assistant", metadata: { usage }, parts },
    ];
    await updateMessage(conversationId, { messages });

    if (!interrupted) {
      try {
        const compaction = await planChatCompaction({
          model: runModel.model as Parameters<typeof planChatCompaction>[0]["model"],
          target: runModel.target,
          messages: history,
          prior: current?.compaction ?? null,
          usedTokens: usageTokens(usage as Parameters<typeof usageTokens>[0]),
        });
        if (compaction) await updateMessage(conversationId, { compaction });
      } catch (error) {
        console.warn(`[compaction] voice turn failed: ${error}`);
      }
    }
    if (scope && !silent) {
      void runMemoryExtraction({
        conversationId,
        scope,
        messages,
        label: `${device.name} conversation`,
        source: "device",
        defaultPrompt: DEVICE_MEMORY_EXTRACTION_PROMPT,
      }).catch((error) => console.warn(`[memory] voice extraction failed: ${error}`));
    }

    const status: VoiceTurnStatus = silent
      ? "silent"
      : interrupted
        ? "interrupted"
        : !canSpeak
          ? "not_spoken"
          : played.length && played.every((p) => p.ok)
            ? "spoken"
            : "failed";
    return record(status, {
      conversationId,
      reply: silent ? SILENT : storedText,
      voice,
      ...(muted && { reason: "muted" }),
      ...(quiet && { reason: "quiet hours" }),
      model: { provider: runModel.provider, model: runModel.modelId },
      inputTokens: usage.inputTokens,
      cachedInputTokens: (usage as { inputTokenDetails?: { cacheReadTokens?: number } }).inputTokenDetails?.cacheReadTokens,
      outputTokens: usage.outputTokens,
      chunks: played.map((p) => ({ ok: p.ok, ms: p.ms, ...(p.error && { error: p.error }) })),
    });
  } catch (error) {
    speaker.stop();
    console.error(`[voice] turn failed for ${deviceId}:`, error);
    return record("failed", {
      conversationId,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
  } finally {
    // Turns are serialised per device, so the reply on the session is this one's.
    if (session) session.reply = null;
  }
}

function mainLanguage(turn: HeardTurn): string | undefined {
  const counts = new Map<string, number>();
  for (const l of turn.lines) if (l.language) counts.set(l.language, (counts.get(l.language) ?? 0) + l.text.length);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

type Played = { text: string; ok: boolean; ms?: number; error?: string };

/** Synthesises sentences in order and sends each to the device as soon as it's ready; the device queues them. */
class ReplySpeaker {
  private chain: Promise<void> = Promise.resolve();
  private acks: Promise<Played>[] = [];
  private stopped = false;
  private sent = false;
  private pending = 0;

  constructor(
    private readonly device: Device,
    private readonly settings: DeviceSettings,
    private readonly voice: string,
    private readonly language: string,
    private readonly deps: VoiceTurnDeps,
    private readonly onFirstAudio: () => void
  ) {}

  /** From the first chunk sent until every chunk is acknowledged. */
  get speaking(): boolean {
    return this.sent && this.pending > 0;
  }

  say(sentence: string): void {
    const text = speakable(sentence);
    if (!text) return;
    this.chain = this.chain.then(async () => {
      if (this.stopped) return;
      try {
        const audio = await this.deps.synthesize({
          ownerId: this.device.ownerId,
          speech: this.settings.speech,
          text,
          voice: this.voice,
          language: this.language,
        });
        if (this.stopped) return;
        this.onFirstAudio();
        this.sent = true;
        this.pending++;
        const ack = this.deps.send(this.device.id, audio).then(
          (p) => ({ text, ok: p.ok, ms: p.durationMs, ...(p.error && { error: p.error }) }),
          (error) => ({ text, ok: false, error: error instanceof Error ? error.message : String(error) })
        );
        this.acks.push(ack.finally(() => this.pending--));
      } catch (error) {
        this.acks.push(Promise.resolve({ text, ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sent) this.deps.stop(this.device.id);
  }

  async finish(): Promise<Played[]> {
    await this.chain;
    return Promise.all(this.acks);
  }
}
