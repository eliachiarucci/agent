import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
vi.mock("../../lib/global/ai", async () => {
  const { fakeEmbedding } = await import("../helpers/embeddings");
  return {
    embedText: async (text: string) => fakeEmbedding(text),
    chatModelFromSettings: () => {
      throw new Error("not used in these tests");
    },
  };
});
vi.mock("../../lib/agent/context", () => ({
  getContextWindow: vi.fn(async () => ({ model: "test", contextLength: 1_000_000, supportsImages: true })),
}));
import { executeVoiceTurn, heardNotes, type VoiceTurnDeps } from "../../lib/agent/voice-turn";
import { latestDeviceConversation } from "../../lib/db/conversations";
import { createDevice, listDeviceEvents } from "../../lib/db/devices";
import { withDeviceLock } from "../../lib/devices/lock";
import { writeFrame } from "../../lib/devices/frames";
import { TakenPictures } from "../../lib/agent/pictures";
import sharp from "sharp";
import type { AudioHeader } from "../../lib/devices/protocol";
import { DEFAULT_DEVICE_SETTINGS, mergeDeviceSettings } from "../../lib/devices/settings";
import { generateDeviceToken } from "../../lib/devices/tokens";
import { BARGE_IN_MS, VoiceSession, linesFromTokens, voiceSessions, type HeardTurn } from "../../lib/devices/voice/session";
import { NoSttKeyError, SonioxStream, openStt, sonioxKey, type SttStream, type SttToken } from "../../lib/devices/voice/stt";
import { upsertProviderSetting } from "../../lib/db/provider-settings";
import { SentenceSplitter, SilenceGate, heardBlock, speakable } from "../../lib/devices/voice/text";
import { closeDb, makeUserWithAgent, resetDb } from "../helpers/db";
import { silentWav } from "../helpers/fake-piper";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-voice-"));
  process.env.FILES_DIR = root;
});
beforeEach(resetDb);
afterAll(async () => {
  await closeDb();
  await rm(root, { recursive: true, force: true });
});

describe("voice text", () => {
  it("split a streamed reply into sentences for speech", () => {
    const s = new SentenceSplitter();
    expect(s.push("Hello there, Marco. How ")).toEqual(["Hello there, Marco."]);
    expect(s.push("are you? It costs 3.5 euros. Mr. Rossi is ")).toEqual(["How are you?", "It costs 3.5 euros."]);
    expect(s.push("here")).toEqual([]);
    expect(s.flush()).toBe("Mr. Rossi is here");
    expect(s.flush()).toBeNull();
    // A newline ends a sentence too.
    expect(new SentenceSplitter().push("First line\nsecond")).toEqual(["First line"]);
  });

  it("hold the start of a reply until it can't be <silent/>", () => {
    const silent = new SilenceGate();
    expect(silent.push(" <sil")).toBe("");
    expect(silent.push("ent/>")).toBe("");
    expect(silent.state).toBe("silent");
    expect(silent.push(" anything")).toBe("");

    const speak = new SilenceGate();
    expect(speak.push("<")).toBe("");
    expect(speak.push("b>Hi")).toBe("<b>Hi");
    expect(speak.state).toBe("speak");
    expect(speak.push(" there")).toBe(" there");

    const empty = new SilenceGate();
    empty.finish();
    expect(empty.state).toBe("silent");
  });

  it("speak only words, and format what was heard", () => {
    expect(speakable('<speak><parameter name="text">It\'s **9:10**.</parameter>')).toBe("It's 9:10.");
    expect(speakable("<silent/>")).toBe("");
    expect(heardBlock("Tue 13 Oct, 21:10:08", [{ speaker: "voice 1", text: "Hi" }], ["in conversation: you spoke 4 s ago"])).toBe(
      "<heard> Tue 13 Oct, 21:10:08 (in conversation: you spoke 4 s ago)\nvoice 1: Hi\n</heard>"
    );
    expect(heardBlock("Tue 13 Oct, 21:10:08", [{ speaker: "voice 1", text: "Hey Dino", language: "en" }])).toBe(
      "<heard> Tue 13 Oct, 21:10:08\nvoice 1 (en): Hey Dino\n</heard>"
    );
  });

  it("group final tokens by voice, with each stretch's main language", () => {
    const t = (text: string, speaker: string, language: string): SttToken => ({ text, speaker, language, isFinal: true });
    expect(
      linesFromTokens([t("Ciao", "1", "it"), t(" Dino", "1", "it"), t(" Hi", "2", "en"), t(" there.", "2", "en")])
    ).toEqual([
      { speaker: "voice 1", text: "Ciao Dino", language: "it" },
      { speaker: "voice 2", text: "Hi there.", language: "en" },
    ]);
  });
});

describe("device lock", () => {
  it("run one at a time, voice turns ahead of waiting runs", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withDeviceLock("d", () => new Promise<void>((r) => (release = () => (order.push("run 1"), r()))));
    const run2 = withDeviceLock("d", async () => void order.push("run 2"));
    const voice = withDeviceLock("d", async () => void order.push("voice"), true);
    release();
    await Promise.all([first, run2, voice]);
    expect(order).toEqual(["run 1", "voice", "run 2"]);
  });
});

class FakeStt extends EventEmitter implements SttStream {
  sent = 0;
  finalized = 0;
  closed = false;
  get open() {
    return !this.closed;
  }
  send(pcm: Buffer) {
    this.sent += pcm.length;
  }
  finalize() {
    this.finalized++;
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}

const voiceSettings = { ...DEFAULT_DEVICE_SETTINGS.voice, endOfTurnMs: 300 };
const header = (segment: string, seq: number, flags: Partial<AudioHeader> = {}): AudioHeader => ({
  type: "audio",
  segment,
  seq,
  format: "pcm_s16le",
  sampleRate: 16000,
  ...flags,
});
const pcm = (ms: number) => Buffer.alloc(ms * 32);
const final = (text: string, speaker = "1"): SttToken => ({ text, speaker, language: "en", isFinal: true });

describe("taken pictures", () => {
  it("go right after the tool message holding their result", () => {
    const pictures = new TakenPictures();
    pictures.add("b", { image: new Uint8Array([1]), label: "picture" });
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "b", toolName: "takePicture", input: {} }] },
      { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "b", toolName: "takePicture", output: { type: "json" as const, value: {} } }] },
      { role: "assistant" as const, content: "ok" },
    ];
    const out = pictures.insert(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    expect(new TakenPictures().prepareStep({ messages })).toEqual({});
  });
});

describe("the Soniox key", () => {
  it("fails a stream without a key, without connecting", async () => {
    const stream = new SonioxStream(Promise.resolve(null), { languageHints: ["en"] });
    const errors: Error[] = [];
    stream.on("error", (e) => errors.push(e));
    const closed = new Promise((resolve) => stream.once("close", resolve));
    stream.send(pcm(40));
    stream.finalize();
    await closed;
    expect(errors[0]).toBeInstanceOf(NoSttKeyError);
    expect(stream.open).toBe(false);
  });

  it("closes a stream still waiting for its key", async () => {
    const stream = new SonioxStream(new Promise<string | null>(() => {}), { languageHints: ["en"] });
    const closed = new Promise((resolve) => stream.once("close", resolve));
    stream.close();
    await closed;
    expect(stream.open).toBe(false);
  });

  it("drops audio for a minute after 'no key', then looks again", async () => {
    let now = 1_000_000;
    let lookups = 0;
    const s = new VoiceSession("dev", "owner", () => voiceSettings, () => null, {
      openStt,
      sttKey: async () => (lookups++, null),
      now: () => now,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      s.onAudio(header("a", 0, { start: true }), pcm(40));
      await new Promise((r) => setTimeout(r, 0));
      s.onAudio(header("a", 1), pcm(40));
      s.onAudio(header("a", 2), pcm(40));
      expect(lookups).toBe(1);
      now += 61_000;
      s.onAudio(header("a", 3), pcm(40));
      expect(lookups).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      s.close();
    }
  });

  it("is the owner's stored Soniox key, unless SONIOX_API_KEY overrides it", async () => {
    const { user } = await makeUserWithAgent("Kim");
    const env = process.env.SONIOX_API_KEY;
    delete process.env.SONIOX_API_KEY;
    try {
      expect(await sonioxKey(user.id)).toBeNull();
      await upsertProviderSetting(user.id, "soniox", { apiKey: "stored-key" });
      expect(await sonioxKey(user.id)).toBe("stored-key");
      process.env.SONIOX_API_KEY = "env-key";
      expect(await sonioxKey(user.id)).toBe("env-key");
    } finally {
      if (env === undefined) delete process.env.SONIOX_API_KEY;
      else process.env.SONIOX_API_KEY = env;
    }
  });
});

describe("voice session", () => {
  function session() {
    const stt = new FakeStt();
    const turns: HeardTurn[] = [];
    const s = new VoiceSession("dev", "owner", () => voiceSettings, () => (_id, turn) => turns.push(turn), {
      openStt: () => stt,
      sttKey: async () => "key",
      now: () => Date.now(),
    });
    return { s, stt, turns };
  }

  it("finalise after the device's silence and hand over the turn", () => {
    vi.useFakeTimers();
    try {
      const { s, stt, turns } = session();
      s.onAudio(header("a", 0, { start: true }), pcm(500));
      s.onAudio(header("a", 1, { end: true }), Buffer.alloc(0));
      expect(stt.finalized).toBe(0);
      vi.advanceTimersByTime(300);
      expect(stt.finalized).toBe(1);
      stt.emit("tokens", [final("Hey"), final(" Dino.")], []);
      stt.emit("fin");
      expect(turns).toHaveLength(1);
      expect(turns[0].lines).toEqual([{ speaker: "voice 1", text: "Hey Dino.", language: "en" }]);
      expect(turns[0].audioMs).toBe(500);
      s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keep collecting when speech resumes before the final text", () => {
    vi.useFakeTimers();
    try {
      const { s, stt, turns } = session();
      s.onAudio(header("a", 0, { start: true }), pcm(300));
      s.onAudio(header("a", 1, { end: true }), Buffer.alloc(0));
      vi.advanceTimersByTime(300);
      s.onAudio(header("b", 2, { start: true }), pcm(300));
      stt.emit("tokens", [final("Hey Dino,")], []);
      stt.emit("fin");
      expect(turns).toHaveLength(0);
      s.onAudio(header("b", 3, { end: true }), Buffer.alloc(0));
      vi.advanceTimersByTime(300);
      stt.emit("tokens", [final(" what time is it?")], []);
      stt.emit("fin");
      expect(turns.map((t) => t.lines[0].text)).toEqual(["Hey Dino, what time is it?"]);
      s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // One stretch of speech: start, audio, end; then the final text after the silence.
  function speak(s: VoiceSession, stt: FakeStt, segment: string, ms: number, words: string[]) {
    s.onAudio(header(segment, 0, { start: true }), pcm(ms));
    s.onAudio(header(segment, 1, { end: true }), Buffer.alloc(0));
    vi.advanceTimersByTime(voiceSettings.endOfTurnMs);
    stt.emit("tokens", words.map((w) => final(w)), []);
    stt.emit("fin");
  }

  it("interrupt the reply after enough new speech, and mark the next turn as talking over it", () => {
    vi.useFakeTimers();
    try {
      const { s, stt, turns } = session();
      const interrupt = vi.fn();
      s.reply = { started: () => true, interrupt };
      s.onAudio(header("a", 0, { start: true }), pcm(200));
      expect(interrupt).not.toHaveBeenCalled();
      s.onAudio(header("a", 1), pcm(BARGE_IN_MS - 200));
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(false);
      expect(s.reply).toBeNull();
      s.onAudio(header("a", 2, { end: true }), Buffer.alloc(0));
      vi.advanceTimersByTime(voiceSettings.endOfTurnMs);
      stt.emit("tokens", [final("No, the other one.")], []);
      stt.emit("fin");
      expect(turns[0]).toMatchObject({ afterInterruption: true, lines: [{ text: "No, the other one." }] });
      expect(turns[0].continued).toBeUndefined();
      s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("merge a turn into the next one when the person goes on before its reply played", () => {
    vi.useFakeTimers();
    try {
      const { s, stt, turns } = session();
      speak(s, stt, "a", 1500, ["You know that's not a couch, right?"]);
      expect(turns).toHaveLength(1);
      // The reply is being written (nothing sent yet) when they go on talking.
      const interrupt = vi.fn();
      s.reply = { started: () => false, interrupt };
      speak(s, stt, "b", 900, [" It's like a sofa bed."]);
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(true);
      expect(turns).toHaveLength(2);
      expect(turns[1].lines).toEqual([
        { speaker: "voice 1", text: "You know that's not a couch, right? It's like a sofa bed.", language: "en" },
      ]);
      expect(turns[1]).toMatchObject({ continued: true });
      expect(turns[1].afterInterruption).toBeUndefined();

      // Speech with no words in it still hands the dropped turn back, alone.
      s.reply = { started: () => false, interrupt: vi.fn() };
      speak(s, stt, "c", 600, []);
      expect(turns[2].lines.map((l) => l.text)).toEqual(["You know that's not a couch, right? It's like a sofa bed."]);
      s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tell how long ago the device spoke, for the conversation window", () => {
    vi.useFakeTimers();
    try {
      const { s, stt, turns } = session();
      speak(s, stt, "a", 600, ["Hey Dino."]);
      expect(turns[0].sinceReplyMs).toBeNull();
      s.replied(Date.now());
      vi.advanceTimersByTime(8000);
      speak(s, stt, "b", 600, ["Don't you trust me?"]);
      expect(turns[1].sinceReplyMs).toBe(8000 + voiceSettings.endOfTurnMs);
      s.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("voice turn", () => {
  async function makeDevice() {
    const { user, agent } = await makeUserWithAgent("Elia");
    return createDevice({
      ownerId: user.id,
      agentId: agent.id,
      name: "Dino",
      tokenHash: generateDeviceToken().hash,
      settings: mergeDeviceSettings(DEFAULT_DEVICE_SETTINGS, {
        timezone: "Europe/Rome",
        speech: { quietHours: null },
      }),
    });
  }

  // A model that streams the reply in small pieces.
  function streamingModel(reply: string) {
    const pieces = reply.match(/.{1,7}/gs) ?? [];
    return new MockLanguageModelV3({
      provider: "mock",
      modelId: "mock-voice",
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "t" },
            ...pieces.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
            { type: "text-end" as const, id: "t" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: {
                inputTokens: { total: 4000, noCache: 100, cacheRead: 3900, cacheWrite: 0 },
                outputTokens: { total: 20, text: 20, reasoning: 0 },
              },
            },
          ],
          chunkDelayInMs: 5,
        }),
      }),
    });
  }

  // The fake device plays clips one after another, like the rover: a clip
  // acknowledges after it played, or as stopped once stop_speech came.
  function deps(model: MockLanguageModelV3, sent: string[], options: { onPlay?: (n: number) => void } = {}) {
    const stops: number[] = [];
    let queue: Promise<unknown> = Promise.resolve();
    const d: VoiceTurnDeps = {
      now: () => new Date(),
      resolveModel: async () => ({
        model,
        provider: "lmstudio",
        modelId: "mock-voice",
        target: { provider: "lmstudio", settings: {}, model: "mock-voice" },
      }),
      speak: async () => ({ spoken: false, reason: "not used" }),
      capture: async () => {
        throw new Error("not used");
      },
      ask: async () => "not used",
      synthesize: async ({ text }) => ({
        audio: new Uint8Array(silentWav(400)),
        format: "wav",
        sampleRate: 22050,
        durationMs: 400 + text.length,
      }),
      send: (_id, audio) => {
        sent.push(String(audio.durationMs));
        const n = sent.length;
        const played = queue.then(async () => {
          if (stops.length) return { speechId: "s", ok: false, durationMs: 0, error: "Stopped" };
          options.onPlay?.(n);
          await new Promise((r) => setTimeout(r, 30));
          return stops.length
            ? { speechId: "s", ok: false, durationMs: 10, error: "Stopped" }
            : { speechId: "s", ok: true, durationMs: audio.durationMs };
        });
        queue = played;
        return played;
      },
      stop: () => {
        stops.push(1);
        return true;
      },
    };
    return { d, stops };
  }

  const turn = (text: string): HeardTurn => ({
    lines: [{ speaker: "voice 1", text, language: "en" }],
    at: new Date(),
    speechEndAt: Date.now() - 400,
    finalAt: Date.now() - 100,
    audioMs: 1500,
  });

  const lastTexts = (messages: UIMessage[]) =>
    messages.map((m) => `${m.role}: ${m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ")}`);

  it("speak a reply sentence by sentence and keep the exchange in the device's conversation", async () => {
    const device = await makeDevice();
    const sent: string[] = [];
    const reply = "It's nine in the evening. Anything else? I'm here.";
    const { d } = deps(streamingModel(reply), sent);
    expect(await executeVoiceTurn(device.id, turn("Hey Dino, what time is it?"), d)).toBe("spoken");
    // One clip per sentence, in order (the fake TTS encodes the text length in the duration).
    expect(sent).toEqual(["It's nine in the evening.", "Anything else?", "I'm here."].map((s) => String(400 + s.length)));
    const conversation = await latestDeviceConversation(device.id);
    const texts = lastTexts(conversation!.messages as UIMessage[]);
    expect(texts[0]).toMatch(/^user: <heard> .+\nvoice 1 \(en\): Hey Dino, what time is it\?\n<\/heard>$/);
    expect(texts[1]).toBe(`assistant: ${reply}`);
    const [event] = await listDeviceEvents({ deviceId: device.id, kind: "voice", limit: 5 });
    expect(event.detail).toMatchObject({ status: "spoken", reply, cachedInputTokens: 3900 });
    expect(Object.keys(event.detail?.latencyMs as object)).toEqual(
      expect.arrayContaining(["final", "request", "firstToken", "firstSentence", "firstAudio"])
    );
  });

  it("take a picture when asked what's in view, and show it to the model after the tool's result", async () => {
    const device = await makeDevice();
    const sent: string[] = [];
    const frame = await writeFrame(
      device.id,
      await sharp({ create: { width: 2576, height: 1449, channels: 3, background: "#884422" } }).jpeg().toBuffer()
    );
    const prompts: any[] = [];
    const finish = {
      type: "finish" as const,
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
    };
    const model = new MockLanguageModelV3({
      provider: "mock",
      modelId: "mock-voice",
      doStream: async (options) => {
        prompts.push(options.prompt);
        const chunks =
          prompts.length === 1
            ? [
                { type: "stream-start" as const, warnings: [] },
                { type: "tool-call" as const, toolCallId: "call-1", toolName: "takePicture", input: "{}" },
                { ...finish, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" } },
              ]
            : [
                { type: "stream-start" as const, warnings: [] },
                { type: "text-start" as const, id: "t" },
                { type: "text-delta" as const, id: "t", delta: "A brown card." },
                { type: "text-end" as const, id: "t" },
                finish,
              ];
        return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 1 }) };
      },
    });
    const { d } = deps(model, sent);
    d.capture = async () => ({ kind: "overview", observation: { frame } as any });
    expect(await executeVoiceTurn(device.id, turn("Dino, what am I holding?"), d)).toBe("spoken");

    // The second step sees the picture as an image, right after the tool's result, downscaled.
    const second = prompts[1] as any[];
    const toolAt = second.findIndex((m) => m.role === "tool");
    const picture = second[toolAt + 1];
    expect(picture.role).toBe("user");
    const file = picture.content.find((p: any) => p.type === "file");
    expect(file.mediaType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(file.data)).metadata();
    expect([meta.width, meta.height]).toEqual([1568, 882]);
    const conversation = await latestDeviceConversation(device.id);
    expect(lastTexts(conversation!.messages as UIMessage[]).at(-1)).toBe("assistant: A brown card.");
  });

  it("keep what was said, not stray markup, in the conversation", async () => {
    const device = await makeDevice();
    const sent: string[] = [];
    const { d } = deps(streamingModel("Sure.<speak>It's **noon**.</speak>"), sent);
    expect(await executeVoiceTurn(device.id, turn("Hey Dino, what time is it?"), d)).toBe("spoken");
    const conversation = await latestDeviceConversation(device.id);
    expect(lastTexts(conversation!.messages as UIMessage[])[1]).toBe("assistant: Sure. It's noon.");
  });

  it("say nothing on <silent/>", async () => {
    const device = await makeDevice();
    const sent: string[] = [];
    const { d } = deps(streamingModel("<silent/>"), sent);
    expect(await executeVoiceTurn(device.id, turn("We need more coffee."), d)).toBe("silent");
    expect(sent).toEqual([]);
    const conversation = await latestDeviceConversation(device.id);
    expect(lastTexts(conversation!.messages as UIMessage[])[1]).toBe("assistant: <silent/>");
  });

  it("stop when interrupted and keep only what was played", async () => {
    const device = await makeDevice();
    // A session must exist for barge-in; it opens on the first audio.
    voiceSessions.setDeps({ openStt: () => new FakeStt() });
    voiceSessions.onAudio(device.id, device.ownerId, () => voiceSettings, header("a", 0, { start: true }), pcm(100));
    const sent: string[] = [];
    const { d, stops } = deps(streamingModel("Once upon a time, a cat. She lived by the shed. The end."), sent, {
      // Barge in while the second sentence plays.
      onPlay: (n) => {
        if (n === 2) voiceSessions.get(device.id)!.reply!.interrupt(false);
      },
    });
    expect(await executeVoiceTurn(device.id, turn("Dino, tell me a story."), d)).toBe("interrupted");
    expect(stops).toHaveLength(1);
    const conversation = await latestDeviceConversation(device.id);
    expect(lastTexts(conversation!.messages as UIMessage[])[1]).toBe(
      "assistant: Once upon a time, a cat. [interrupted]"
    );
    voiceSessions.drop(device.id);
  });

  it("keep nothing of a turn whose reply was dropped for the next turn", async () => {
    const device = await makeDevice();
    voiceSessions.setDeps({ openStt: () => new FakeStt() });
    voiceSessions.onAudio(device.id, device.ownerId, () => voiceSettings, header("a", 0, { start: true }), pcm(100));
    const sent: string[] = [];
    const { d } = deps(streamingModel("A couch is a long seat with a back and arms, for two or more people."), sent);
    // They go on talking while the reply is still being written.
    setTimeout(() => voiceSessions.get(device.id)!.reply!.interrupt(true), 15);
    expect(await executeVoiceTurn(device.id, turn("You know that's not a couch, right?"), d)).toBe("merged");
    expect(sent).toEqual([]);
    const conversation = await latestDeviceConversation(device.id);
    expect(conversation!.messages).toEqual([]);
    voiceSessions.drop(device.id);
  });

  it("note in the heard header that it's a conversation, or that they talked over the reply", async () => {
    const device = await makeDevice();
    const sent: string[] = [];
    const { d } = deps(streamingModel("I do trust you."), sent);
    const t = { ...turn("Why would it take my word? Don't you trust me?"), sinceReplyMs: 18_000, afterInterruption: true };
    expect(await executeVoiceTurn(device.id, t, d)).toBe("spoken");
    const conversation = await latestDeviceConversation(device.id);
    expect(lastTexts(conversation!.messages as UIMessage[])[0]).toMatch(
      /^user: <heard> .+ \(talking over your reply; in conversation: you spoke 18 s ago\)\n/
    );
    expect(heardNotes({ ...turn("x"), sinceReplyMs: 31_000 })).toEqual([]);
  });
});
