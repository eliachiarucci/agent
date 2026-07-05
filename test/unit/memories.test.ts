import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// searchMemories ranks with SQL using stored vectors, so scripting the vectors
// scripts the relevance term exactly: same vector = cosine 1, different fake
// seeds ≈ orthogonal ≈ 0. No LM Studio involved.
const fixedEmbeddings = vi.hoisted(() => new Map<string, number[]>());
vi.mock("../../lib/global/ai", async () => {
  const { fakeEmbedding } = await import("../helpers/embeddings");
  return {
    embedText: async (text: string) => fixedEmbeddings.get(text) ?? fakeEmbedding(text),
  };
});

import {
  createMemory,
  findMemories,
  findSimilarMemories,
  getPinnedMemories,
  searchMemories,
  updateMemory,
} from "../../lib/db/memories";
import {
  buildMemorySystemPrompt,
  buildMemoryTools,
  MEMORY_SYSTEM_PROMPT,
  type MemoryScope,
} from "../../lib/agent/memory";
import { fakeEmbedding } from "../helpers/embeddings";
import { closeDb, makeUser, makeUserWithAgent, resetDb } from "../helpers/db";

const CAR_TOPIC = fakeEmbedding("topic:cars");

beforeEach(async () => {
  await resetDb();
  fixedEmbeddings.clear();
});
afterAll(closeDb);

async function carScenario() {
  const elia = await makeUser("Elia");
  const anna = await makeUser("Anna");
  const { agent } = await makeUserWithAgent("Owner", [elia, anna]);

  const facts = [
    { content: "Elia's car is a Golf 7", subjectUserId: elia.id },
    { content: "Anna's car is a Fiat Panda", subjectUserId: anna.id },
    { content: "The kitchen renovation budget is 10000 euro", subjectUserId: null },
  ];
  for (const fact of facts) {
    // Identical vectors: relevance/recency/importance all tie, so ranking is
    // decided purely by the subject bonus under test.
    fixedEmbeddings.set(fact.content, CAR_TOPIC);
    await createMemory({ ...fact, poolId: agent.memoryPoolId!, importance: 0.5, category: "other" });
  }
  fixedEmbeddings.set("my car", CAR_TOPIC);

  return { elia, anna, agent };
}

describe("searchMemories subject boost", () => {
  it("ranks other members' facts last on ambiguous queries, per speaker", async () => {
    const { elia, anna, agent } = await carScenario();

    const forElia = await searchMemories(agent.memoryPoolId!, "my car", { speakerUserId: elia.id });
    expect(forElia.map((m) => m.content).at(-1)).toBe("Anna's car is a Fiat Panda");

    const forAnna = await searchMemories(agent.memoryPoolId!, "my car", { speakerUserId: anna.id });
    expect(forAnna.map((m) => m.content).at(-1)).toBe("Elia's car is a Golf 7");
  });

  it("boosts shared (subject-less) facts alongside the speaker's own", async () => {
    const { elia, agent } = await carScenario();

    const results = await searchMemories(agent.memoryPoolId!, "my car", { speakerUserId: elia.id });
    const topTwo = results.slice(0, 2).map((m) => m.content);
    expect(topTwo).toContain("Elia's car is a Golf 7");
    expect(topTwo).toContain("The kitchen renovation budget is 10000 euro");
  });

  it("applies no bonus when the speaker is unknown", async () => {
    const { agent } = await carScenario();

    const results = await searchMemories(agent.memoryPoolId!, "my car");
    const scores = results.map((m) => m.score);
    // All three memories tie on every score component without the bonus.
    expect(Math.max(...scores) - Math.min(...scores)).toBeLessThan(1e-6);
  });
});

describe("searchMemories scoping and filters", () => {
  it("never returns memories from another pool", async () => {
    const { agent: agentA } = await makeUserWithAgent("Alice");
    const { agent: agentB } = await makeUserWithAgent("Bob");

    fixedEmbeddings.set("Bob's secret fact", CAR_TOPIC);
    fixedEmbeddings.set("anything", CAR_TOPIC);
    await createMemory({
      poolId: agentB.memoryPoolId!,
      content: "Bob's secret fact",
      importance: 0.9,
      category: "other",
    });

    expect(await searchMemories(agentA.memoryPoolId!, "anything")).toHaveLength(0);
    expect(await searchMemories(agentB.memoryPoolId!, "anything")).toHaveLength(1);
  });

  it("excludes pinned memories from search results (they are always in the prompt)", async () => {
    const { agent } = await makeUserWithAgent("Alice");
    fixedEmbeddings.set("Alice is allergic to peanuts", CAR_TOPIC);
    fixedEmbeddings.set("allergies", CAR_TOPIC);
    await createMemory({
      poolId: agent.memoryPoolId!,
      content: "Alice is allergic to peanuts",
      importance: 1,
      category: "health",
      pinned: true,
    });

    expect(await searchMemories(agent.memoryPoolId!, "allergies")).toHaveLength(0);
    expect(await getPinnedMemories(agent.memoryPoolId!)).toHaveLength(1);
  });

  it("drops memories below the minRelevance floor", async () => {
    const { agent } = await makeUserWithAgent("Alice");
    // Different fake seeds are near-orthogonal: relevance ≈ 0 for the stray fact.
    await createMemory({
      poolId: agent.memoryPoolId!,
      content: "Alice's car is a Golf 7",
      importance: 0.5,
      category: "other",
    });
    await createMemory({
      poolId: agent.memoryPoolId!,
      content: "Completely unrelated quantum chromodynamics trivia",
      importance: 0.9,
      category: "other",
    });
    fixedEmbeddings.set("what car does she drive", fakeEmbedding("Alice's car is a Golf 7"));

    const results = await searchMemories(agent.memoryPoolId!, "what car does she drive", {
      minRelevance: 0.45,
    });
    expect(results.map((m) => m.content)).toEqual(["Alice's car is a Golf 7"]);
  });
});

describe("findSimilarMemories", () => {
  it("returns memories above the floor, scoped to the pool, including pinned", async () => {
    const { agent } = await makeUserWithAgent("Alice");
    const { agent: other } = await makeUserWithAgent("Bob");
    await createMemory({
      poolId: agent.memoryPoolId!,
      content: "Alice's car is a Golf 7",
      importance: 0.5,
      category: "other",
      pinned: true,
    });
    await createMemory({
      poolId: agent.memoryPoolId!,
      content: "Completely unrelated quantum chromodynamics trivia",
      importance: 0.5,
      category: "other",
    });

    // Same seed = identical vector: similarity 1; other seeds ≈ orthogonal.
    const probe = fakeEmbedding("Alice's car is a Golf 7");
    const hits = await findSimilarMemories(agent.memoryPoolId!, probe, { minSimilarity: 0.8 });
    expect(hits.map((m) => m.content)).toEqual(["Alice's car is a Golf 7"]);
    expect(hits[0].similarity).toBeCloseTo(1, 5);

    expect(await findSimilarMemories(other.memoryPoolId!, probe, { minSimilarity: 0.8 })).toHaveLength(0);
  });
});

describe("remember tool duplicate guard", () => {
  const callOptions = { toolCallId: "test", messages: [] };

  async function rememberScenario() {
    const { user, agent } = await makeUserWithAgent("Alice");
    const scope: MemoryScope = {
      agentId: agent.id,
      poolId: agent.memoryPoolId!,
      speaker: { id: user.id, name: "Alice" },
      members: [{ userId: user.id, name: "Alice", role: "member" }],
    };
    const existing = await createMemory({
      poolId: agent.memoryPoolId!,
      content: "Alice's car is a Golf 7",
      subjectUserId: user.id,
      importance: 0.5,
      category: "other",
    });
    // The paraphrase embeds to the same vector: cosine 1, above any floor.
    fixedEmbeddings.set("Alice drives a Golf 7", fakeEmbedding("Alice's car is a Golf 7"));
    return { agent, existing, tools: buildMemoryTools(scope) };
  }

  it("refuses a near-duplicate and returns the existing memory's id", async () => {
    const { agent, existing, tools } = await rememberScenario();

    const result = (await tools.remember.execute!(
      { content: "Alice drives a Golf 7", subject: "Alice", importance: 0.5, category: "other" },
      callOptions
    )) as { stored: boolean; similar: Array<{ id: string }> };

    expect(result.stored).toBe(false);
    expect(result.similar.map((m) => m.id)).toContain(existing.id);
    expect(await findMemories(agent.memoryPoolId!)).toHaveLength(1);
  });

  it("stores anyway when allowDuplicate is set", async () => {
    const { agent, tools } = await rememberScenario();

    const result = (await tools.remember.execute!(
      {
        content: "Alice drives a Golf 7",
        subject: "Alice",
        importance: 0.5,
        category: "other",
        allowDuplicate: true,
      },
      callOptions
    )) as { id: string };

    expect(result.id).toBeDefined();
    expect(await findMemories(agent.memoryPoolId!)).toHaveLength(2);
  });

  it("stores distinct facts without tripping the guard", async () => {
    const { agent, tools } = await rememberScenario();

    const result = (await tools.remember.execute!(
      {
        content: "Alice's favourite food is carbonara",
        subject: "Alice",
        importance: 0.5,
        category: "food",
      },
      callOptions
    )) as { id: string; stored: string };

    expect(result.stored).toBe("Alice's favourite food is carbonara");
    expect(await findMemories(agent.memoryPoolId!)).toHaveLength(2);
  });
});

describe("buildMemorySystemPrompt custom prompt", () => {
  async function promptScenario() {
    const { user, agent } = await makeUserWithAgent("Alice");
    await createMemory({
      poolId: agent.memoryPoolId!,
      content: "Alice is vegetarian",
      importance: 0.9,
      category: "food",
      pinned: true,
    });
    const scope: MemoryScope = {
      agentId: agent.id,
      poolId: agent.memoryPoolId!,
      speaker: { id: user.id, name: user.name },
      members: [{ userId: user.id, name: user.name, role: "owner" }],
    };
    return scope;
  }

  it("assembles the built-in instructions with members and pinned memories", async () => {
    const scope = await promptScenario();
    const prompt = await buildMemorySystemPrompt(scope, { sharedConversation: false });

    expect(prompt).toContain("You assist one person: Alice.");
    expect(prompt).toContain("Alice is vegetarian");
    expect(prompt).toContain("## Memory rules");
  });

  it("replaces the instructions with the custom prompt but keeps the dynamic context", async () => {
    const scope = await promptScenario();
    const prompt = await buildMemorySystemPrompt(scope, {
      sharedConversation: false,
      customPrompt: "Only ever talk about memories in haiku.",
    });

    expect(prompt.startsWith("Only ever talk about memories in haiku.")).toBe(true);
    // Members line and pinned memories still ride along; the built-in rules don't.
    expect(prompt).toContain("You assist one person: Alice.");
    expect(prompt).toContain("Alice is vegetarian");
    expect(prompt).not.toContain("## Memory rules");
  });

  it("exports the copyable default as exactly the instruction text", async () => {
    const scope = await promptScenario();
    const prompt = await buildMemorySystemPrompt(scope, { sharedConversation: false });
    // The endpoint-served default is the built prompt minus the dynamic parts,
    // so pasting it back as a custom prompt reproduces the built-in behaviour.
    const [intro, rules] = MEMORY_SYSTEM_PROMPT.split("\n\n");
    expect(prompt).toContain(intro);
    expect(prompt).toContain(rules);
  });
});

describe("updateMemory / cross-pool protection", () => {
  it("re-embeds on content change and refuses cross-pool updates", async () => {
    const { agent } = await makeUserWithAgent("Alice");
    const { agent: otherAgent } = await makeUserWithAgent("Bob");
    const memory = await createMemory({
      poolId: agent.memoryPoolId!,
      content: "Alice's car is a Golf 7",
      importance: 0.5,
      category: "other",
    });

    // Scoped to the wrong pool: must not touch the row.
    expect(await updateMemory(otherAgent.memoryPoolId!, memory.id, { content: "hijacked" })).toBeUndefined();

    const updated = await updateMemory(agent.memoryPoolId!, memory.id, { content: "Alice's car is a Tesla" });
    expect(updated?.content).toBe("Alice's car is a Tesla");
    expect(updated?.embedding).not.toEqual(memory.embedding);
  });
});
