import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

describe("agent system prompt", () => {
  it("lets the owner set, read back, and clear the prompt", async () => {
    const owner = new TestClient(BASE);
    await signUp(owner, "Owner");
    const agentId: string = (await owner.get("/agent/agents")).body[0].id;

    const set = await owner.patch("/agent/agents", {
      id: agentId,
      system_prompt: "Always answer in pirate speak.",
    });
    expect(set.status).toBe(200);
    expect(set.body.systemPrompt).toBe("Always answer in pirate speak.");

    // The list endpoint carries it, so the UI can populate the textarea.
    const listed = (await owner.get("/agent/agents")).body[0];
    expect(listed.systemPrompt).toBe("Always answer in pirate speak.");

    // Whitespace-only clears back to null, same as an explicit null.
    const cleared = await owner.patch("/agent/agents", { id: agentId, system_prompt: "  " });
    expect(cleared.body.systemPrompt).toBeNull();
  });

  it("updates the prompt without touching the name, and vice versa", async () => {
    const owner = new TestClient(BASE);
    await signUp(owner, "Owner");
    const agentId: string = (await owner.get("/agent/agents")).body[0].id;

    const promptOnly = await owner.patch("/agent/agents", {
      id: agentId,
      system_prompt: "Be terse.",
    });
    expect(promptOnly.body.name).toBe("Personal Assistant");

    const nameOnly = await owner.patch("/agent/agents", { id: agentId, name: "Renamed" });
    expect(nameOnly.body.name).toBe("Renamed");
    expect(nameOnly.body.systemPrompt).toBe("Be terse.");
  });

  it("rejects updates from non-owners and empty patches", async () => {
    const owner = new TestClient(BASE);
    const member = new TestClient(BASE);
    await signUp(owner, "Owner");
    const memberUser = await signUp(member, "Member");

    const agentId: string = (await owner.get("/agent/agents")).body[0].id;
    await owner.post("/agent/members", { agent_id: agentId, member_id: memberUser.id });

    // A member of the shared agent still cannot edit its prompt.
    const fromMember = await member.patch("/agent/agents", {
      id: agentId,
      system_prompt: "hijacked",
    });
    expect(fromMember.status).toBe(403);

    const empty = await owner.patch("/agent/agents", { id: agentId });
    expect(empty.status).toBe(400);
  });

  it("lets the owner set, read back, and clear the memory model", async () => {
    const owner = new TestClient(BASE);
    await signUp(owner, "Owner");
    const fresh = (await owner.get("/agent/agents")).body[0];
    // A fresh agent has no memory model: the extractor uses the env default.
    expect(fresh.memoryProvider).toBeNull();
    expect(fresh.memoryModel).toBeNull();

    const set = await owner.patch("/agent/agents", {
      id: fresh.id,
      memory_provider: "anthropic",
      memory_model: "claude-opus-4-8",
    });
    expect(set.status).toBe(200);
    expect(set.body.memoryProvider).toBe("anthropic");
    expect(set.body.memoryModel).toBe("claude-opus-4-8");

    // The list endpoint carries the pair so the picker shows the current choice.
    const listed = (await owner.get("/agent/agents")).body[0];
    expect(listed.memoryProvider).toBe("anthropic");
    expect(listed.memoryModel).toBe("claude-opus-4-8");

    // Clearing both resets to the env default model.
    const cleared = await owner.patch("/agent/agents", {
      id: fresh.id,
      memory_provider: null,
      memory_model: null,
    });
    expect(cleared.body.memoryProvider).toBeNull();
    expect(cleared.body.memoryModel).toBeNull();
  });

  it("lets the owner toggle the extraction second pass and override its prompt", async () => {
    const owner = new TestClient(BASE);
    await signUp(owner, "Owner");
    const fresh = (await owner.get("/agent/agents")).body[0];
    // Fresh agents extract with the built-in prompt.
    expect(fresh.memoryExtractionEnabled).toBe(true);
    expect(fresh.memoryExtractionPrompt).toBeNull();

    const set = await owner.patch("/agent/agents", {
      id: fresh.id,
      memory_extraction_enabled: false,
      memory_extraction_prompt: "Only remember birthdays.",
    });
    expect(set.status).toBe(200);
    expect(set.body.memoryExtractionEnabled).toBe(false);
    expect(set.body.memoryExtractionPrompt).toBe("Only remember birthdays.");

    // The list endpoint carries both so the settings tab can populate.
    const listed = (await owner.get("/agent/agents")).body[0];
    expect(listed.memoryExtractionEnabled).toBe(false);
    expect(listed.memoryExtractionPrompt).toBe("Only remember birthdays.");

    // Whitespace-only clears the override back to the built-in prompt.
    const cleared = await owner.patch("/agent/agents", {
      id: fresh.id,
      memory_extraction_enabled: true,
      memory_extraction_prompt: "  ",
    });
    expect(cleared.body.memoryExtractionEnabled).toBe(true);
    expect(cleared.body.memoryExtractionPrompt).toBeNull();
  });

  it("rejects extraction settings from non-owners", async () => {
    const owner = new TestClient(BASE);
    const member = new TestClient(BASE);
    await signUp(owner, "Owner");
    const memberUser = await signUp(member, "Member");

    const agentId: string = (await owner.get("/agent/agents")).body[0].id;
    await owner.post("/agent/members", { agent_id: agentId, member_id: memberUser.id });

    const fromMember = await member.patch("/agent/agents", {
      id: agentId,
      memory_extraction_enabled: false,
    });
    expect(fromMember.status).toBe(403);
  });

  it("lets the owner toggle chat memory and override its prompt", async () => {
    const owner = new TestClient(BASE);
    await signUp(owner, "Owner");
    const fresh = (await owner.get("/agent/agents")).body[0];
    // Fresh agents chat with the built-in memory surface.
    expect(fresh.chatMemoryEnabled).toBe(true);
    expect(fresh.chatMemoryPrompt).toBeNull();

    const set = await owner.patch("/agent/agents", {
      id: fresh.id,
      chat_memory_enabled: false,
      chat_memory_prompt: "Only ever talk about memories in haiku.",
    });
    expect(set.status).toBe(200);
    expect(set.body.chatMemoryEnabled).toBe(false);
    expect(set.body.chatMemoryPrompt).toBe("Only ever talk about memories in haiku.");

    // The list endpoint carries both so the settings tab can populate.
    const listed = (await owner.get("/agent/agents")).body[0];
    expect(listed.chatMemoryEnabled).toBe(false);
    expect(listed.chatMemoryPrompt).toBe("Only ever talk about memories in haiku.");

    // Whitespace-only clears the override back to the built-in instructions.
    const cleared = await owner.patch("/agent/agents", {
      id: fresh.id,
      chat_memory_enabled: true,
      chat_memory_prompt: "  ",
    });
    expect(cleared.body.chatMemoryEnabled).toBe(true);
    expect(cleared.body.chatMemoryPrompt).toBeNull();
  });

  it("serves the built-in memory prompts to signed-in users only", async () => {
    const anon = new TestClient(BASE);
    expect((await anon.get("/agent/memory-prompt")).status).toBe(401);

    const owner = new TestClient(BASE);
    await signUp(owner, "Owner");
    const res = await owner.get("/agent/memory-prompt");
    expect(res.status).toBe(200);
    // Spot-check they are the real prompts, not placeholders.
    expect(res.body.chat).toContain("## Memory rules");
    expect(res.body.extraction).toContain("long-term memory");
  });

  it("rejects an unknown memory provider", async () => {
    const owner = new TestClient(BASE);
    await signUp(owner, "Owner");
    const agentId: string = (await owner.get("/agent/agents")).body[0].id;

    const bad = await owner.patch("/agent/agents", {
      id: agentId,
      memory_provider: "not-a-provider",
      memory_model: "x",
    });
    expect(bad.status).toBe(400);
  });
});
