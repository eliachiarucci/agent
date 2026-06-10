import "dotenv/config";

import { eq } from "drizzle-orm";

const { db } = await import("../lib/global/db");
const { memories } = await import("../lib/global/schema");
const { embedText } = await import("../lib/global/ai");

// Re-embeds every memory with the current embedding model. Run once after
// switching models (or changing the document prefix): old and new vectors are
// not comparable, so until this completes retrieval quality is undefined.
//
//   npm run reembed
//
// Idempotent and safe to re-run; rows are updated one by one so an interrupted
// run can simply be restarted.

const rows = await db
  .select({ id: memories.id, content: memories.content })
  .from(memories);

if (rows.length === 0) {
  console.log("No memories to re-embed.");
  process.exit(0);
}

console.log(`Re-embedding ${rows.length} memories…`);
let done = 0;
for (const row of rows) {
  const embedding = await embedText(row.content, "document");
  await db.update(memories).set({ embedding }).where(eq(memories.id, row.id));
  done += 1;
  if (done % 25 === 0 || done === rows.length) console.log(`  ${done}/${rows.length}`);
}
console.log("Done.");
process.exit(0);
