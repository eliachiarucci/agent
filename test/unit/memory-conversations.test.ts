import type { ModelMessage } from "ai";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  getMemoryConversation,
  saveMemoryConversation,
} from "../../lib/db/memory-conversations";
import { createMessage, deleteMessage } from "../../lib/db/conversations";
import { closeDb, makeUserWithAgent, resetDb } from "../helpers/db";

beforeEach(resetDb);
afterAll(closeDb);

async function makeConversation() {
  const { user, agent } = await makeUserWithAgent("Elia");
  const conversation = await createMessage({
    agentId: agent.id,
    userId: user.id,
    shared: false,
    messages: [],
  });
  return { user, agent, conversation };
}

const msgs = (...texts: string[]): ModelMessage[] =>
  texts.map((text) => ({ role: "user", content: text }));

describe("memory conversations", () => {
  it("returns undefined before anything is saved", async () => {
    const { conversation } = await makeConversation();
    expect(await getMemoryConversation(conversation.id)).toBeUndefined();
  });

  it("saves and reads back the extractor's running history", async () => {
    const { agent, conversation } = await makeConversation();
    await saveMemoryConversation(conversation.id, agent.id, msgs("first exchange"));

    const stored = await getMemoryConversation(conversation.id);
    expect(stored?.agentId).toBe(agent.id);
    expect(stored?.messages).toEqual(msgs("first exchange"));
  });

  it("upserts on conversation id: later turns overwrite, never duplicate", async () => {
    const { agent, conversation } = await makeConversation();
    await saveMemoryConversation(conversation.id, agent.id, msgs("turn 1"));
    await saveMemoryConversation(conversation.id, agent.id, msgs("turn 1", "turn 2"));

    const stored = await getMemoryConversation(conversation.id);
    expect(stored?.messages).toEqual(msgs("turn 1", "turn 2"));
  });

  it("is removed when its source conversation is deleted (cascade)", async () => {
    const { agent, conversation } = await makeConversation();
    await saveMemoryConversation(conversation.id, agent.id, msgs("something"));

    await deleteMessage(conversation.id);
    expect(await getMemoryConversation(conversation.id)).toBeUndefined();
  });
});
