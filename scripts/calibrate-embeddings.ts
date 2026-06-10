import "dotenv/config";

const { embedText } = await import("../lib/global/ai");

// Measures the similarity bands that back AUTO_RECALL_MIN_RELEVANCE
// (lib/agent/memory.ts). Run after changing the embedding model or the
// query/memory phrasing, then re-derive the floor and update the constant,
// its comment, and docs/memory.md. test/ai/rag.test.ts guards the result.
//
//   npm run calibrate
//
// Mirrors the production regime: speaker-prefixed queries ("Elia: …") embedded
// as kind "query", third-person memories as kind "document". No database needed.

const memories = [
  "Elia's car is a Golf 7",
  "Anna's car is a Fiat Panda",
  "The kitchen renovation budget is 10000 euro",
  "Elia's favourite food is carbonara",
];

// Query → the memory it should hit (index into `memories`).
const directHits: Array<[string, number]> = [
  ["Elia: can you find rubber mats for my car?", 0],
  ["Anna: what car does Elia drive?", 0],
  ["Anna: how much can we spend on the kitchen?", 2],
  ["Elia: what should I cook tonight?", 3],
  // Multilingual: same intent as the previous query, in Italian.
  ["Elia: cosa dovrei cucinare stasera?", 3],
];

const unrelated = [
  "Elia: summarize the quantum chromodynamics lecture",
  "Elia: what's the weather like tomorrow?",
  "Anna: write a haiku about autumn",
  "Elia: how do I center a div in CSS?",
];

const cosine = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);

const memoryVectors = await Promise.all(memories.map((m) => embedText(m, "document")));

console.log("Direct hits (query → expected memory):");
let hitFloor = Infinity;
for (const [query, expected] of directHits) {
  const q = await embedText(query, "query");
  const sims = memoryVectors.map((v) => cosine(q, v));
  const best = sims.indexOf(Math.max(...sims));
  hitFloor = Math.min(hitFloor, sims[expected]);
  const ok = best === expected ? "ok " : "MISRANKED";
  console.log(`  ${sims[expected].toFixed(3)} ${ok} ${query}`);
}

console.log("Unrelated queries (max similarity against any memory):");
let junkCeiling = -Infinity;
for (const query of unrelated) {
  const q = await embedText(query, "query");
  const max = Math.max(...memoryVectors.map((v) => cosine(q, v)));
  junkCeiling = Math.max(junkCeiling, max);
  console.log(`  ${max.toFixed(3)}     ${query}`);
}

console.log(`\nDirect-hit floor:   ${hitFloor.toFixed(3)}`);
console.log(`Unrelated ceiling:  ${junkCeiling.toFixed(3)}`);
console.log(`Midpoint:           ${((hitFloor + junkCeiling) / 2).toFixed(3)}`);
process.exit(0);
