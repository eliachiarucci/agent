import { readFile } from "node:fs/promises";

// Plain-text base prompt, editable without touching code. Resolved from the
// process working directory (project root locally, /app in Docker). Read on
// every request so edits apply without a restart; a missing file just means
// no extra prompt.
export async function loadSystemPrompt(): Promise<string> {
  try {
    return (await readFile("system-prompt.txt", "utf8")).trim();
  } catch {
    return "";
  }
}
