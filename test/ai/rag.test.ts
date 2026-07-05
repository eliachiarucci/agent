import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, makeUser, makeUserWithAgent, resetDb } from "../helpers/db";
import { createMemory, findSimilarMemories, searchMemories } from "../../lib/db/memories";
import { embedText } from "../../lib/global/ai";
import {
  buildMemoryTools,
  buildRelevantMemoriesBlock,
  type MemoryScope,
} from "../../lib/agent/memory";

// Real EmbeddingGemma embeddings, in-process — no LM Studio involved (the
// first-ever run downloads the model, ~300MB). Embeddings for fixed text are
// deterministic, so ranking assertions are stable — unlike chat output.
describe("RAG retrieval with real embeddings", () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  async function householdScenario() {
    const elia = await makeUser("Elia");
    const anna = await makeUser("Anna");
    const { agent } = await makeUserWithAgent("Owner", [elia, anna]);

    const facts = [
      { content: "Elia's car is a Golf 7", subjectUserId: elia.id, category: "other" },
      { content: "Anna's car is a Fiat Panda", subjectUserId: anna.id, category: "other" },
      {
        content: "The kitchen renovation budget is 10000 euro",
        subjectUserId: null,
        category: "event",
      },
      { content: "Elia's favourite food is carbonara", subjectUserId: elia.id, category: "food" },
    ] as const;
    for (const fact of facts) {
      await createMemory({ ...fact, poolId: agent.memoryPoolId!, importance: 0.5 });
    }

    return { elia, anna, agent };
  }

  it('"my car" retrieves the speaker\'s own car first, per speaker', async () => {
    const { elia, anna, agent } = await householdScenario();

    const forElia = await searchMemories(
      agent.memoryPoolId!,
      "Elia: can you find rubber mats for my car?",
      { speakerUserId: elia.id }
    );
    expect(forElia[0].content).toBe("Elia's car is a Golf 7");

    const forAnna = await searchMemories(
      agent.memoryPoolId!,
      "Anna: can you find rubber mats for my car?",
      { speakerUserId: anna.id }
    );
    expect(forAnna[0].content).toBe("Anna's car is a Fiat Panda");
  });

  it("shared facts rank top for any member on matching queries", async () => {
    const { anna, agent } = await householdScenario();

    const results = await searchMemories(
      agent.memoryPoolId!,
      "Anna: how much can we spend on the kitchen?",
      { speakerUserId: anna.id }
    );
    expect(results[0].content).toBe("The kitchen renovation budget is 10000 euro");
  });

  it("explicit questions about another member still surface their facts", async () => {
    const { anna, agent } = await householdScenario();

    const results = await searchMemories(agent.memoryPoolId!, "Anna: what car does Elia drive?", {
      speakerUserId: anna.id,
    });
    expect(results.map((m) => m.content).slice(0, 2)).toContain("Elia's car is a Golf 7");
  });

  it("retrieves across languages (Italian query, English memory)", async () => {
    const { elia, agent } = await householdScenario();

    const results = await searchMemories(agent.memoryPoolId!, "Elia: cosa dovrei cucinare stasera?", {
      speakerUserId: elia.id,
    });
    expect(results[0].content).toBe("Elia's favourite food is carbonara");
  });

  it("duplicate guard trips on paraphrases and contradictions, not on distinct facts", async () => {
    const { elia, agent } = await householdScenario();

    // Doc-vs-doc bands behind DUPLICATE_MIN_SIMILARITY (lib/agent/memory.ts):
    // paraphrases and changed-value updates of a stored fact must clear the
    // threshold, distinct facts must not. A failure here usually means the
    // calibration drifted — re-measure with `npm run calibrate`.
    const paraphrase = await embedText("Elia drives a Volkswagen Golf 7", "document");
    expect(
      (await findSimilarMemories(agent.memoryPoolId!, paraphrase, { minSimilarity: 0.8 })).map(
        (m) => m.content
      )
    ).toContain("Elia's car is a Golf 7");

    const contradiction = await embedText("Elia's car is a Tesla Model 3", "document");
    expect(
      (await findSimilarMemories(agent.memoryPoolId!, contradiction, { minSimilarity: 0.8 })).map(
        (m) => m.content
      )
    ).toContain("Elia's car is a Golf 7");

    // Same-shaped fact about another member, and a new fact about the same
    // member: both must store freely.
    const otherMember = await embedText("Elia's car is a Golf 7", "document");
    const hits = await findSimilarMemories(agent.memoryPoolId!, otherMember, { minSimilarity: 0.8 });
    expect(hits.map((m) => m.content)).not.toContain("Anna's car is a Fiat Panda");

    const newFact = await embedText("Elia plays tennis on Thursdays", "document");
    expect(await findSimilarMemories(agent.memoryPoolId!, newFact, { minSimilarity: 0.8 })).toHaveLength(0);

    // End-to-end through the tool: the paraphrase is refused with the
    // existing memory's id, the distinct fact is stored.
    const scope: MemoryScope = {
      agentId: agent.id,
      poolId: agent.memoryPoolId!,
      speaker: { id: elia.id, name: "Elia" },
      members: [{ userId: elia.id, name: "Elia", role: "member" }],
    };
    const tools = buildMemoryTools(scope);
    const callOptions = { toolCallId: "test", messages: [] };

    const refused = (await tools.remember.execute!(
      { content: "Elia drives a Volkswagen Golf 7", subject: "Elia", importance: 0.5, category: "other" },
      callOptions
    )) as { stored: boolean; similar: Array<{ content: string }> };
    expect(refused.stored).toBe(false);
    expect(refused.similar.map((m) => m.content)).toContain("Elia's car is a Golf 7");

    const storedResult = (await tools.remember.execute!(
      { content: "Elia plays tennis on Thursdays", subject: "Elia", importance: 0.5, category: "preference" },
      callOptions
    )) as { id: string; stored: string };
    expect(storedResult.stored).toBe("Elia plays tennis on Thursdays");
  });

  it("auto-recall injects relevant memories and stays silent on unrelated queries", async () => {
    const { elia, agent } = await householdScenario();
    const scope: MemoryScope = {
      agentId: agent.id,
      poolId: agent.memoryPoolId!,
      speaker: { id: elia.id, name: "Elia" },
      members: [{ userId: elia.id, name: "Elia", role: "member" }],
    };

    const relevant = await buildRelevantMemoriesBlock(scope, "what should I cook tonight?");
    expect(relevant).toContain("carbonara");

    // Nothing about lectures is stored: the block must be omitted entirely
    // (AUTO_RECALL_MIN_RELEVANCE junk guard).
    const unrelated = await buildRelevantMemoriesBlock(
      scope,
      "summarize the quantum chromodynamics lecture"
    );
    expect(unrelated).toBeNull();
  });
});
