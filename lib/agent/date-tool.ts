import { tool } from "ai";
import { z } from "zod";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Calendar date (YYYY-MM-DD) and weekday name of "now" as seen in `timezone`.
function todayInZone(timezone: string): { date: string; dayOfWeek: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, dayOfWeek: get("weekday") };
}

/**
 * A single date-lookup tool. The model has no reliable sense of the current
 * date — the system prompt is KV-cache-stable and carries no clock — so it must
 * ask. `timezone` is the sender's IANA zone so "today" means their today;
 * stable per session, so it stays KV-cache friendly.
 */
export function buildDateTools(timezone: string) {
  return {
    getDate: tool({
      description:
        'Look up a calendar date. Pass "today" to get the current date in the user\'s timezone, or a specific date as ISO 8601 "YYYY-MM-DD" to get the day of the week it falls on. Use this instead of guessing — you do not otherwise know today\'s date.',
      inputSchema: z.object({
        date: z
          .string()
          .describe(
            '"today" for the current date, or a date as ISO 8601 "YYYY-MM-DD" (e.g. "2005-02-17").'
          ),
      }),
      execute: async ({ date }) => {
        const value = date.trim();
        if (value.toLowerCase() === "today") {
          return { ...todayInZone(timezone), timezone };
        }
        const match = ISO_DATE.exec(value);
        if (!match) {
          return {
            error: `Could not parse "${date}". Pass "today" or a date as ISO 8601 "YYYY-MM-DD".`,
          };
        }
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        // Noon UTC so the weekday never shifts across a day boundary; a date's
        // weekday doesn't depend on timezone anyway.
        const dt = new Date(Date.UTC(year, month - 1, day, 12));
        // Reject impossible dates (e.g. "2005-02-30" rolls over to March 2).
        if (
          dt.getUTCFullYear() !== year ||
          dt.getUTCMonth() !== month - 1 ||
          dt.getUTCDate() !== day
        ) {
          return { error: `"${date}" is not a real calendar date.` };
        }
        const dayOfWeek = new Intl.DateTimeFormat("en-US", {
          timeZone: "UTC",
          weekday: "long",
        }).format(dt);
        return { date: value, dayOfWeek };
      },
    }),
  };
}

// Static (no clock baked in), so the prompt prefix stays KV-cache stable.
export const dateToolPrompt = [
  "## Date",
  '- You do not inherently know the current date. Use the getDate tool (pass "today") to look it up, and to find the weekday of any date.',
].join("\n");
