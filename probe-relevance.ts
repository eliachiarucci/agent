import "dotenv/config";
import { eq, desc, sql, cosineDistance } from "drizzle-orm";
import { db } from "./lib/global/db";
import { memories } from "./lib/global/schema";
import { embedText } from "./lib/global/ai";

const queries = [
  "Can you search good rubber floor mat for my car?",
  // what buildRetrievalQuery produces mid-conversation: prior turns + the message
  "Hi! What can you help me with today?\nI can help with searches, your memories, and more.\nCan you search good rubber floor mat for my car?",
];

for (const q of queries) {
  const embedding = await embedText(q);
  const relevance = sql<number>`1 - (${cosineDistance(memories.embedding, embedding)})`;
  const rows = await db
    .select({ content: memories.content, relevance })
    .from(memories)
    .where(eq(memories.pinned, false))
    .orderBy(desc(relevance))
    .limit(5);
  console.log(`\nQUERY: ${q.replace(/\n/g, " | ").slice(0, 90)}`);
  for (const r of rows) console.log(`  ${Number(r.relevance).toFixed(3)}  ${r.content.slice(0, 80)}`);
}
process.exit(0);
