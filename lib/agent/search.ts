import { tool } from "ai";
import { z } from "zod";
import { convert } from "html-to-text";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8888";

// Keeps tool results small enough for local-model context windows.
const MAX_RESULTS = 8;
const MAX_PAGE_CHARS = 8000;
const FETCH_TIMEOUT_MS = 15_000;

interface SearxngResult {
  title: string;
  url: string;
  content?: string;
  engine?: string;
}

export const searchTools = {
  webSearch: tool({
    description:
      "Search the web for current information. Use it for anything you don't reliably know: recent events, news, prices, software versions, niche facts. Returns titles, URLs and snippets; use readPage on a result when the snippets are not enough to answer.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Search query, phrased like a search engine query"),
    }),
    execute: async ({ query }) => {
      const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return { error: `Search failed with status ${res.status}` };

      const data = (await res.json()) as { results?: SearxngResult[] };
      const results = (data.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? "",
      }));

      if (results.length === 0) return { error: "No results found. Try a different query." };
      return results;
    },
  }),

  readPage: tool({
    description:
      "Fetch a web page and return its content as plain text. Use it after webSearch when a snippet looks promising but you need the full content to answer accurately.",
    inputSchema: z.object({
      url: z.url().describe("The page URL, usually taken from a webSearch result"),
    }),
    execute: async ({ url }) => {
      let res: Response;
      try {
        res = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "User-Agent": "Mozilla/5.0 (compatible; personal-agent/1.0)" },
        });
      } catch {
        return { error: "Could not reach the page (timeout or network error)." };
      }
      if (!res.ok) return { error: `Page returned status ${res.status}` };

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("html") && !contentType.includes("text")) {
        return { error: `Unsupported content type: ${contentType}` };
      }

      const text = convert(await res.text(), {
        wordwrap: false,
        selectors: [
          { selector: "nav", format: "skip" },
          { selector: "header", format: "skip" },
          { selector: "footer", format: "skip" },
          { selector: "script", format: "skip" },
          { selector: "style", format: "skip" },
          { selector: "a", options: { ignoreHref: true } },
          { selector: "img", format: "skip" },
        ],
      })
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return {
        url,
        content: text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n\n[truncated]` : text,
      };
    },
  }),
};

export const webSearchPrompt = [
  "## Web access",
  "- You can search the internet with webSearch and read full pages with readPage.",
  "- Use them for current events or facts you are unsure about instead of guessing; cite the source URL when you rely on a page.",
  `- Today's date is ${new Date().toISOString().slice(0, 10)}.`,
].join("\n");
