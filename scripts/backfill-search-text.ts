import "dotenv/config";

const { backfillSearchText } = await import("../lib/db/conversations");

// Recomputes conversations.search_text (and thus the generated full-text vector)
// from each conversation's messages. Deploys do this automatically at startup for
// rows that lack it (see index.ts), so this script is mainly for dev, or to
// re-extract EVERY row after changing the extraction logic in messageSearchText.
//
//   npm run backfill:search
//
// Idempotent and safe to re-run.

const filled = await backfillSearchText({ all: true });
console.log(`Backfilled search text for ${filled} conversations.`);
process.exit(0);
