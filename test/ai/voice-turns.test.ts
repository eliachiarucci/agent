import { generateText, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildGmailTools, gmailPromptFor, gmailApprovalTargetsFor, gmailToolInfo } from "../../lib/agent/connectors/gmail";
import { filterConnectorTools } from "../../lib/agent/connectors/shared";
import { SILENT, deviceContextBlock, deviceSystemPrompt } from "../../lib/agent/device-run";
import { loadSystemPrompt } from "../../lib/agent/system-prompt";
import { answerAfterTools, heardNotes, withoutNarration } from "../../lib/agent/voice-turn";
import { perceptionProviderOptions } from "../../lib/devices/perception-model";
import type { HeardTurn } from "../../lib/devices/voice/session";
import { heardBlock, type HeardLine } from "../../lib/devices/voice/text";
import { chatModelFromSettings } from "../../lib/global/ai";
import { closeDb, makeUserWithAgent } from "../helpers/db";
import { CONFIRM, buildTriggerTools } from "../../lib/devices/trigger-tools";
import { DEFAULT_DEVICE_SETTINGS } from "../../lib/devices/settings";
import type { Device } from "../../lib/db/devices";

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
  return (await turn(messages)).text;
}

// One turn, with tools: the reply, the tool calls made and the messages the turn added.
async function turn(messages: ModelMessage[], tools?: ToolSet) {
  const system = deviceSystemPrompt({
    basePrompt: await loadSystemPrompt(),
    agentPrompt: null,
    memorySystemPrompt: "",
    deviceName: "Dino",
    description: "A small rover with a camera, a microphone and a speaker, in Elia's flat.",
    disabledTools: [],
    connectorsPrompt: tools && "search_threads" in tools ? gmailPromptFor(tools) : undefined,
  });
  const result = await generateText({
    model: chatModelFromSettings("openrouter", { apiKey: KEY, region: "eu" }, MODEL),
    system,
    messages,
    tools,
    // As in voice turns: text before a tool call is narration, not shown again.
    prepareStep: ({ messages: all }) => ({ messages: withoutNarration(all, messages.length) }),
    stopWhen: stepCountIs(4),
    providerOptions: perceptionProviderOptions("openrouter", MODEL),
    maxOutputTokens: 400,
  });
  // As in voice turns: called tools, then <silent/>, gets one more try.
  let text = result.text.trim();
  if (tools && text.startsWith(SILENT) && result.steps.length > 1) {
    text =
      (await answerAfterTools({
        model: chatModelFromSettings("openrouter", { apiKey: KEY, region: "eu" }, MODEL),
        system,
        messages: withoutNarration([...messages, ...result.response.messages.slice(0, -1)], messages.length),
        tools,
        providerOptions: perceptionProviderOptions("openrouter", MODEL),
      })) ?? text;
  }
  return {
    text,
    calls: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    added: result.response.messages,
  };
}

// The Gmail tools as a device gets them ("ask" ones behind a spoken yes), on a fake mailbox.
function mailbox(userId: string, agentId: string, conversationId: string, turnId: string) {
  const sent = vi.fn(async () => ({ message_id: "m-9", note: "Email sent." }));
  const real = buildGmailTools(userId, undefined, "allow");
  const fake: ToolSet = {
    search_threads: {
      ...real.search_threads,
      execute: async () => ({
        threads: [
          { thread_id: "t-1", subject: "Your order has shipped", from: "Amazon <ship@amazon.it>", date: "Wed, 14 Oct 2026 09:12", message_count: 1, snippet: "Arriving Friday" },
          { thread_id: "t-2", subject: "Dinner on Saturday?", from: "Marco Rossi <marco@example.com>", date: "Wed, 14 Oct 2026 15:40", message_count: 1, snippet: "Are you free on Saturday evening?" },
        ],
      }),
    },
    get_thread: { ...real.get_thread, execute: async () => ({ error: "not in this test" }) },
    send_email: { ...real.send_email, execute: sent },
  };
  const tools = filterConnectorTools({
    connector: "gmail",
    userId,
    tools: fake,
    toolInfo: gmailToolInfo,
    approval: { agentId, spoken: { conversationId, turnId, heard: true } },
    targetsFor: gmailApprovalTargetsFor,
  });
  return { tools, sent };
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
  afterAll(closeDb);

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

  it("reads the owner's email when asked", async () => {
    const { user, agent } = await makeUserWithAgent("Mail reader");
    for (let i = 0; i < RUNS; i++) {
      const { tools } = mailbox(user.id, agent.id, `read-${i}`, "turn-1");
      const result = await turn([heard([me("Dino, do I have any new emails?")])], tools);
      expect(result.calls, `run ${i + 1}`).toContain("search_threads");
      expect(result.text.startsWith(SILENT), `run ${i + 1} stayed silent`).toBe(false);
    }
  });

  it("sends an email only after a spoken yes", async () => {
    const { user, agent } = await makeUserWithAgent("Mail sender");
    for (let i = 0; i < RUNS; i++) {
      const conversation = `send-${i}`;
      const ask = heard([me("Dino, email marco@example.com that I'll be ten minutes late for dinner.")]);
      const first = mailbox(user.id, agent.id, conversation, "turn-1");
      const asked = await turn([ask], first.tools);
      expect(first.sent, `run ${i + 1} sent without a yes`).not.toHaveBeenCalled();
      expect(asked.text.startsWith(SILENT), `run ${i + 1} didn't ask`).toBe(false);

      const second = mailbox(user.id, agent.id, conversation, "turn-2");
      const yes = heard([me("Yes, send it.")], { sinceReplyMs: 3_000 });
      const done = await turn([ask, ...asked.added, yes], second.tools);
      expect(second.sent, `run ${i + 1} didn't send after the yes`).toHaveBeenCalledTimes(1);
      expect(done.text.startsWith(SILENT)).toBe(false);
    }
  });

  // The trigger tools as a device has them, recording their calls instead of storing anything.
  function triggerTools() {
    const calls: Array<{ name: string; input: any }> = [];
    const real = buildTriggerTools({
      device: { id: "d", name: "Dino", hello: null } as unknown as Device,
      settings: DEFAULT_DEVICE_SETTINGS,
      agentId: "a",
      timeZone: "Europe/Rome",
      source: "voice",
      now: () => new Date(),
    });
    const tools: ToolSet = Object.fromEntries(
      Object.entries(real).map(([name, t]) => [
        name,
        {
          ...t,
          execute: async (input: any) => {
            calls.push({ name, input });
            return name === "watchFor"
              ? { set: `t-${calls.length}: watch for "${input.what}", once, until 17:36. Note: ${input.note}`, note: "Frames are checked when the view changes, up to 300 an hour.", reply: CONFIRM }
              : { set: `t-${calls.length}: reminder at 16:46. Note: ${input.note}`, reply: CONFIRM };
          },
        },
      ])
    );
    return { tools, calls };
  }

  it("sets a watch when asked to say when something comes into view", async () => {
    for (let i = 0; i < RUNS; i++) {
      const { tools, calls } = triggerTools();
      const result = await turn(
        [heard([me("Dino, let me know when a computer mouse comes into your view.")])],
        tools
      );
      const watch = calls.find((c) => c.name === "watchFor");
      expect(watch, `run ${i + 1} made no watch (said: ${result.text})`).toBeDefined();
      expect(watch!.input.what).toMatch(/mouse/i);
      expect(result.text.startsWith(SILENT), `run ${i + 1} silent after the watch`).toBe(false);
    }
  });

  it("sets a reminder when asked to remind them later", async () => {
    for (let i = 0; i < RUNS; i++) {
      const { tools, calls } = triggerTools();
      const result = await turn([heard([me("Dino, remind me in ten minutes to take the pasta off the stove.")])], tools);
      const reminder = calls.find((c) => c.name === "remindAt");
      expect(reminder, `run ${i + 1} set no reminder (said: ${result.text})`).toBeDefined();
      expect(reminder!.input.in_minutes ?? reminder!.input.at).toBeTruthy();
      expect(reminder!.input.note).toMatch(/pasta/i);
    }
  });

  it("tells them out loud when a watch it set fires, even with nobody in view", async () => {
    const now = new Date();
    const report = deviceContextBlock({
      device: { name: "Dino" } as Device,
      timeZone: "Europe/Rome",
      now,
      triggers: [
        {
          kind: "trigger",
          at: now,
          detail:
            'watch for "a computer mouse" seen at 18:31:02 (set 18:02; a one-time watch, now done). Your note: Voice 1 asked at 18:02 to be told when a computer mouse comes into view. Tell them out loud.',
        },
      ],
      since: new Date(now.getTime() - 60_000),
      captions: [],
      speech: [],
      frame: null,
    });
    for (let i = 0; i < RUNS; i++) {
      const said: string[] = [];
      const tools: ToolSet = {
        speak: tool({
          description: "Say something out loud through Dino's speaker.",
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => (said.push(text), { spoken: true }),
        }),
      };
      await turn(
        [
          { role: "user", content: `${report.replace("No frame is available.", "The newest frame shows a black computer mouse held up in front of the camera; nobody's face is in view.")}` },
        ],
        tools
      );
      expect(said.join(" "), `run ${i + 1} didn't speak`).toMatch(/mouse/i);
    }
  });
});
