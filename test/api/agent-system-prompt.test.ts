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
