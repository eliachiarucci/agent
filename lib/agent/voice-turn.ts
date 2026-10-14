import {
  convertToModelMessages,
  extractReasoningMiddleware,
  generateText,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
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
import { CONVERSATION_WINDOW_MS, voiceSessions, type HeardTurn } from "../devices/voice/session";
import { SpokenReply, heardBlock, speakable } from "../devices/voice/text";
import { applyCompaction, planChatCompaction, usageTokens } from "./compaction";
import {
  DEVICE_MEMORY_EXTRACTION_PROMPT,
  SILENT,
  buildDeviceTools,
  defaultDeviceRunDeps,
  deviceConnectorTools,
  deviceSystemPrompt,
  loadDeviceConversation,
  resolveRunModel,
  type DeviceRunDeps,
} from "./device-run";
import { inlineImageFileParts, windowImageParts } from "./image-parts";
import { readConversationFileBytes } from "./files";
import { TakenPictures, insertStoredPictures } from "./pictures";
import { buildMemorySystemPrompt, buildRelevantMemoriesBlock, type MemoryScope } from "./memory";
import { runMemoryExtraction } from "./memory-extraction";
import { withPromptCache } from "./prompt-cache";
import { stepsToUIMessageParts } from "./step-ui-messages";
import { loadSystemPrompt } from "./system-prompt";
import { deviceDescription } from "../devices/observation-tools";
import { triggersBlock } from "../devices/triggers";
import { listDeviceTriggers } from "../db/device-triggers";

// A voice turn (plan 4.11): what the device's microphone heard is appended to
// the device's conversation as a <heard> message; the agent replies, streamed,
// and each finished sentence is synthesised (Piper) and sent to the device,
// which plays the chunks back to back. A reply of exactly <silent/> is never
// spoken. New speech while the device talks interrupts it: the reply stops and
// the stored reply keeps only what was played.

const IMAGE_WINDOW = 2;
const MAX_STEPS = 4;

// merged: the person went on talking before any of the reply played; the turn
// went in front of their next one and isn't kept on its own.
export type VoiceTurnStatus =
  | "spoken"
  | "silent"
  | "interrupted"
  | "merged"
  | "not_spoken"
  | "failed"
  | "no_agent"
  | "no_model";

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
  return v.provider ? { ...settings.agent, provider: v.provider, model: v.model } : settings.agent;
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
  const heard = heardBlock(
    `${localDayLabel(turn.at, timeZone)}, ${localTime(turn.at, timeZone, true)}`,
    turn.lines,
    heardNotes(turn)
  );
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
  const turnId = crypto.randomUUID();
  const [basePrompt, memoriesBlock, memorySystemPrompt, connectors, setAside] = await Promise.all([
    loadSystemPrompt(),
    memoryScope ? buildRelevantMemoriesBlock(memoryScope, heardText.slice(-2000)) : null,
    memoryScope
      ? buildMemorySystemPrompt(memoryScope, {
          sharedConversation: true,
          customPrompt: agent.chatMemoryPrompt,
          deviceName: device.name,
        })
      : "",
    deviceConnectorTools({ settings, ownerId: owner.id, agentId: agent.id, conversationId, turnId, heard: true }),
    listDeviceTriggers(deviceId, agent.id),
  ]);
  const setAsideBlock = triggersBlock(setAside, timeZone, deps.now());

  const metadata: VoiceTurnMetadata = {
    voiceTurn: { at: turn.at.toISOString(), speakers: [...new Set(turn.lines.map((l) => l.speaker))] },
  };
  history.push({
    id: turnId,
    role: "user",
    metadata,
    parts: [
      ...(memoriesBlock ? [{ type: "text" as const, text: memoriesBlock }] : []),
      { type: "text", text: heard },
      ...(setAsideBlock ? [{ type: "text" as const, text: setAsideBlock }] : []),
    ],
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
  let merged = false;
  const session = voiceSessions.get(deviceId);
  if (session) {
    session.reply = {
      started: () => speaker.started,
      interrupt: (intoNext) => {
        interrupted = true;
        merged = intoNext;
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
      disabledTools: settings.tools.disabled,
      connectorsPrompt: connectors.prompt,
    });
    // No speak tool: the reply itself is spoken.
    const pictures = new TakenPictures();
    const { speak: _speak, ...tools } = buildDeviceTools({
      device,
      settings,
      deps,
      memoryScope,
      conversationId,
      timeZone,
      agentId: agent.id,
      ownerId: owner.id,
      pictures,
      connectorTools: connectors.tools,
      source: "voice",
    });
    const modelView = await inlineImageFileParts(
      windowImageParts(applyCompaction(history, current?.compaction ?? null), IMAGE_WINDOW),
      conversationId
    );
    // Pictures taken earlier in the conversation, back in view as images.
    const modelMessages = await insertStoredPictures(
      await convertToModelMessages(modelView, { tools, ignoreIncompleteToolCalls: true }),
      (file) => readConversationFileBytes(conversationId, file, "upload")
    );
    mark("request");
    const requestMessages = withPromptCache(system, modelMessages, runModel.provider === "anthropic");
    const model = wrapLanguageModel({
      model: runModel.model as Parameters<typeof wrapLanguageModel>[0]["model"],
      middleware: extractReasoningMiddleware({ tagName: "think" }),
    });
    const result = streamText({
      model,
      ...requestMessages,
      tools,
      // This turn's text before a tool call is narration: the model doesn't see it again.
      prepareStep: ({ messages }) => ({
        messages: pictures.insert(withoutNarration(messages, requestMessages.messages.length)),
      }),
      providerOptions: runModel.providerOptions,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: abort.signal,
    });

    const reply = new SpokenReply();
    const canSpeak = !muted && !quiet;
    const say = (sentences: string[]) => {
      for (const sentence of sentences) {
        mark("firstSentence");
        if (canSpeak && !interrupted) speaker.say(sentence);
      }
    };
    try {
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          mark("firstToken");
          say(reply.push(part.text));
        } else if (part.type === "tool-input-start" || part.type === "tool-call") {
          reply.toolCall();
        } else if (part.type === "finish-step") {
          reply.endStep();
        } else if (part.type === "error") {
          throw part.error;
        }
      }
    } catch (error) {
      if (!interrupted) throw error;
    }
    say(reply.finish());

    // Called tools, then <silent/>: someone asked, so one more try at the answer.
    let retried: string | null = null;
    if (reply.silent && !interrupted && (await result.steps).length > 1) {
      const response = await result.response;
      const answered = response.messages.slice(0, -1);
      retried = await answerAfterTools({
        model,
        system: requestMessages.system,
        messages: pictures.insert(withoutNarration([...requestMessages.messages, ...answered], requestMessages.messages.length)),
        tools,
        providerOptions: runModel.providerOptions,
        abortSignal: abort.signal,
      }).catch(() => null);
      if (retried) {
        const again = new SpokenReply();
        say(again.push(retried));
        say(again.finish());
      }
    }
    const played = await speaker.finish();

    // Nothing was played: the session puts these words in front of the next
    // turn, so this exchange isn't kept (the next one holds it all).
    if (merged) {
      await updateMessage(conversationId, { messages: history.slice(0, -1) });
      return record("merged", { conversationId });
    }

    const silent = reply.silent && !retried;
    const spokenText = played.filter((p) => p.ok).map((p) => p.text).join(" ");
    const storedText = silent
      ? SILENT
      : interrupted
        ? `${spokenText}${spokenText ? " " : ""}[interrupted]`
        : speakable(retried ?? reply.text);
    let parts: UIMessage["parts"] = [{ type: "text", text: storedText }];
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
    if (!interrupted) {
      const steps = await result.steps;
      // The history keeps what was said, not stray markup (a "<speak>" in it gets copied by later turns).
      // Narration before a tool call isn't kept either (later turns would copy it).
      const kept = steps.map((step, i) =>
        reply.dropped.has(i) ? { ...step, content: step.content.filter((c) => c.type !== "text") } : step
      );
      const stepParts = stepsToUIMessageParts(kept).map((part) =>
        part.type === "text" && !silent ? { ...part, text: speakable(part.text) } : part
      );
      if (retried) {
        const last = stepParts.findLastIndex((part) => part.type === "text");
        if (last >= 0) stepParts[last] = { type: "text", text: speakable(retried), state: "done" };
        else stepParts.push({ type: "text", text: speakable(retried), state: "done" });
      }
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
        fallbackModel: runModel.target,
      }).catch((error) => console.warn(`[memory] voice extraction failed: ${error}`));
    }

    if (session && spokenText) session.replied(deps.now().getTime());
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

/**
 * One more try at the answer of a turn that called tools and then said
 * <silent/> (the model now and then decides it has nothing to add, e.g. after
 * setting a watch whose note says to tell them later). Tools stay listed (the
 * history calls them) but can't be called. Null if it is silent again.
 */
export async function answerAfterTools(params: {
  model: LanguageModel;
  system?: string;
  messages: ModelMessage[];
  tools: ToolSet;
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  const result = await generateText({ ...params, toolChoice: "none", maxOutputTokens: 400 });
  const text = result.text.trim();
  return text && !text.startsWith(SILENT) ? text : null;
}

/** The messages with the text taken out of this turn's assistant messages that call tools. */
export function withoutNarration(messages: ModelMessage[], from: number): ModelMessage[] {
  return messages.map((m, i) =>
    i >= from && m.role === "assistant" && Array.isArray(m.content) && m.content.some((p) => p.type === "tool-call")
      ? { ...m, content: m.content.filter((p) => p.type !== "text") }
      : m
  );
}

/** What the <heard> header says about the conversation (the rules explain both). */
export function heardNotes(turn: HeardTurn): string[] {
  const notes: string[] = [];
  if (turn.afterInterruption) notes.push("talking over your reply");
  if (turn.sinceReplyMs != null && turn.sinceReplyMs <= CONVERSATION_WINDOW_MS) {
    notes.push(`in conversation: you spoke ${Math.max(1, Math.round(turn.sinceReplyMs / 1000))} s ago`);
  }
  return notes;
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

  /** Some of the reply was sent to the device. */
  get started(): boolean {
    return this.sent;
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
