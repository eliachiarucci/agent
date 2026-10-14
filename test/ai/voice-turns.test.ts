import { generateText, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { SILENT, deviceSystemPrompt } from "../../lib/agent/device-run";
import { loadSystemPrompt } from "../../lib/agent/system-prompt";
import { heardNotes } from "../../lib/agent/voice-turn";
import { perceptionProviderOptions } from "../../lib/devices/perception-model";
import type { HeardTurn } from "../../lib/devices/voice/session";
import { heardBlock, type HeardLine } from "../../lib/devices/voice/text";
import { chatModelFromSettings } from "../../lib/global/ai";

// Voice turns against a real model: does the agent answer, or stay <silent/>,
// in the conversations that went wrong on 2026-10-14 (plan rev 19)? Each
// scenario is the device's conversation as the model sees it (the rules, past
// <heard> blocks and replies) and runs RUNS times, all of which must agree.
//
//   OPENROUTER_API_KEY=… npm run test:ai -- test/ai/voice-turns.test.ts
//
// VOICE_MODEL picks the model (default Claude Haiku 5.5 on Vertex Europe, through the EU endpoint).
const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.VOICE_MODEL ?? "anthropic/claude-haiku-5.5@google-vertex/europe";
const RUNS = Number(process.env.VOICE_RUNS ?? 3);

const TIME = "Wed, 14 Oct 2026, 16:36:20";
const me = (text: string): HeardLine => ({ speaker: "voice 1", text, language: "en" });
const other = (n: number, text: string): HeardLine => ({ speaker: `voice ${n}`, text, language: "en" });
// A <heard> message, with the header notes a turn with this context gets.
const heard = (lines: HeardLine[], context: Partial<HeardTurn> = {}): ModelMessage => ({
  role: "user",
  content: heardBlock(TIME, lines, heardNotes({ lines, at: new Date(), speechEndAt: 0, finalAt: 0, audioMs: 0, ...context })),
});
const said = (text: string): ModelMessage => ({ role: "assistant", content: text });

// TV in the room, as earlier that afternoon: all of it rightly silent.
const tv = (): ModelMessage[] => [
  heard([other(2, "All right, that's what the court is going to do. Sentence you to 6 years in prison, suspended.")]),
  said(SILENT),
  heard([other(2, "There's a $1,500 fine, probated.")]),
  said(SILENT),
];

async function reply(messages: ModelMessage[]): Promise<string> {
  const system = deviceSystemPrompt({
    basePrompt: await loadSystemPrompt(),
    agentPrompt: null,
    memorySystemPrompt: "",
    deviceName: "Dino",
    description: "A small rover with a camera, a microphone and a speaker, in Elia's flat.",
    disabledTools: [],
  });
  const result = await generateText({
    model: chatModelFromSettings("openrouter", { apiKey: KEY, region: "eu" }, MODEL),
    system,
    messages,
    providerOptions: perceptionProviderOptions("openrouter", MODEL),
    maxOutputTokens: 200,
  });
  return result.text.trim();
}

async function expectAnswer(messages: ModelMessage[]) {
  for (let i = 0; i < RUNS; i++) {
    const text = await reply(messages);
    expect(text.startsWith(SILENT), `run ${i + 1} stayed silent`).toBe(false);
    expect(text.length).toBeGreaterThan(3);
  }
}

async function expectSilent(messages: ModelMessage[]) {
  for (let i = 0; i < RUNS; i++) {
    const text = await reply(messages);
    expect(text, `run ${i + 1} answered`).toBe(SILENT);
  }
}

describe.skipIf(!KEY)("voice turns with a real model", () => {
  it("answers a follow-up moments after it spoke, garbled word and all", async () => {
    await expectAnswer([
      heard([me("It is an amplifier module. These are not screw terminals, you see? These are banana plug terminals.")]),
      said("Fair point, banana plug terminals it is. I'll take your word on the amplifier."),
      // "it" was "you": the transcript got it wrong.
      heard([me("Why would it take my word? I mean, don't you trust me?")], { sinceReplyMs: 18_000 }),
    ]);
  });

  it("answers a sentence that was merged after a pause in the middle", async () => {
    await expectAnswer([
      heard([me("What else can you see in my room?")]),
      said("I can see a framed poster, a neon ROCK sign, a white guitar and a couch with colorful cushions."),
      heard([me("You know that's not a couch, right? It's like a sofa bed. Things to lean on.")], {
        sinceReplyMs: 6_000,
        continued: true,
      }),
    ]);
  });

  it("answers when they talk over its reply", async () => {
    await expectAnswer([
      heard([me("Do you know, for example, what this is?")]),
      said("It's a black USB cable, with a USB-C connector at one end [interrupted]"),
      heard([me("Wait, what kind of connector is this?")], { sinceReplyMs: 1_000, afterInterruption: true }),
    ]);
  });

  it("answers its name after a while of TV, in one go", async () => {
    await expectAnswer([...tv(), heard([me("Hey Dino, what time is it?")])]);
  });

  it("stays silent for the TV when nobody talks to it", async () => {
    await expectSilent([...tv(), heard([other(2, "I'm going to give you a choice. The state wants you to do 6 years.")])]);
  });

  it("stays silent for the TV even moments after it spoke", async () => {
    await expectSilent([
      heard([me("Hey Dino, what time is it?")]),
      said("It's twenty to five in the afternoon."),
      ...tv().slice(0, 2),
      heard([other(2, "Place you on 10 years probation."), other(3, "Yes, your honour.")], { sinceReplyMs: 12_000 }),
    ]);
  });
});
