import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { ConnectorAuthError, getConnectorAccessToken } from "./google-auth";
import { filterConnectorTools, read, write, type ConnectorToolInfo } from "./shared";
import type { ToolPermissionLevel } from "../../global/schema";

// Env-overridable so tests can stub the Calendar API with a local server.
const CALENDAR_API_BASE =
  process.env.GOOGLE_CALENDAR_API_BASE ?? "https://www.googleapis.com/calendar/v3";

const FETCH_TIMEOUT_MS = 20_000;
// Keeps tool results small enough for local-model context windows.
const MAX_EVENT_RESULTS = 50;
const MAX_DESCRIPTION_CHARS = 5_000;

// What connecting Calendar asks for. calendar.events covers event writes, so
// no tool needs extra scope or reconsent — the guard against unwanted changes
// is the permission system (write tools default to "ask"), not the scope.
// calendar.readonly additionally covers the calendar list and free/busy
// lookups. openid+email identify the connected account in the UI. Unlike
// Gmail's, these scopes are only "sensitive" (not "restricted"), so testing-
// status refresh tokens don't expire weekly.
export const GOOGLE_CALENDAR_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

// Names mirror Claude's official Google Calendar connector where it has an
// equivalent (list/fetch events, find free time). Read tools default to
// "allow", write tools to "ask" (see shared.ts).
export const googleCalendarToolInfo: ConnectorToolInfo[] = [
  read("list_calendars", "List the user's calendars"),
  read("list_events", "List events in a time window"),
  read("get_event", "Read one event in full"),
  read("find_free_time", "Look up busy intervals across calendars"),
  write("create_event", "Create an event (can invite attendees)"),
  write("update_event", "Modify an existing event"),
  write("delete_event", "Delete an event"),
  write("respond_to_event", "Accept or decline an invitation"),
];

// ── Calendar REST helpers ────────────────────────────────────────────────────

async function calendarFetch<T>(userId: string, path: string, init?: RequestInit): Promise<T> {
  const token = await getConnectorAccessToken(userId, "google-calendar");
  const res = await fetch(`${CALENDAR_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Calendar API error ${res.status}: ${text.slice(0, 300)}`);
  }
  // Event deletion answers 204 with an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Errors become tool results (matching the Gmail tools) so the model can react
// — e.g. tell the user to reconnect — instead of the turn crashing.
async function run<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConnectorAuthError) return { error: err.message };
    return { error: err instanceof Error ? err.message : "Google Calendar request failed" };
  }
}

type EventTime = { date?: string; dateTime?: string; timeZone?: string };
type EventAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
};
type CalendarEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  attendees?: EventAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  recurrence?: string[];
  recurringEventId?: string;
  hangoutLink?: string;
  htmlLink?: string;
};

const ALL_DAY_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Google splits event times into all-day { date } and timed { dateTime[,
// timeZone] } variants; the tools accept one string and route it by shape: a
// bare YYYY-MM-DD is all-day, anything else is an RFC 3339 datetime (which
// needs a UTC offset or an accompanying IANA time_zone).
export function toEventTime(value: string, timeZone?: string): EventTime {
  if (ALL_DAY_DATE.test(value.trim())) return { date: value.trim() };
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

// Flattened back to one string for the model: the all-day date or the datetime.
function flatTime(time: EventTime | undefined): string | undefined {
  return time?.date ?? time?.dateTime;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

// ── Result shaping ───────────────────────────────────────────────────────────

function summarizeEvent(event: CalendarEvent) {
  return {
    event_id: event.id,
    summary: event.summary ?? "(no title)",
    start: flatTime(event.start),
    end: flatTime(event.end),
    ...(event.start?.date ? { all_day: true } : {}),
    ...(event.status && event.status !== "confirmed" ? { status: event.status } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.organizer?.email ? { organizer: event.organizer.email } : {}),
    ...(event.attendees?.length
      ? {
          attendees: event.attendees.map((a) => ({
            email: a.email,
            response: a.responseStatus,
            ...(a.self ? { self: true } : {}),
            ...(a.optional ? { optional: true } : {}),
          })),
        }
      : {}),
    ...(event.recurringEventId ? { recurring_event_id: event.recurringEventId } : {}),
  };
}

function fullEvent(event: CalendarEvent) {
  return {
    ...summarizeEvent(event),
    ...(event.description
      ? { description: truncate(event.description, MAX_DESCRIPTION_CHARS) }
      : {}),
    ...(event.recurrence?.length ? { recurrence: event.recurrence } : {}),
    ...(event.hangoutLink ? { meet_link: event.hangoutLink } : {}),
    ...(event.htmlLink ? { link: event.htmlLink } : {}),
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────

const calendarId = () =>
  z.string().min(1).default("primary").describe('Calendar id from list_calendars; "primary" is the user\'s main calendar');

// RFC 3339 datetimes for timed events (with a UTC offset, or pass time_zone),
// bare YYYY-MM-DD dates for all-day events — shared phrasing for create/update.
const eventTimeDescription =
  'Either an RFC 3339 datetime (e.g. "2026-07-13T15:00:00+02:00" — include the UTC offset or pass time_zone) or a bare "YYYY-MM-DD" for an all-day event';

function allCalendarTools(userId: string): ToolSet {
  return {
    list_calendars: tool({
      description:
        'List the user\'s Google Calendars with their ids. The main one has id "primary"; the other tools default to it, so this is only needed for secondary calendars.',
      inputSchema: z.object({}),
      execute: () =>
        run(async () => {
          const res = await calendarFetch<{
            items?: {
              id?: string;
              summary?: string;
              summaryOverride?: string;
              primary?: boolean;
              timeZone?: string;
              accessRole?: string;
            }[];
          }>(userId, "/users/me/calendarList");
          return {
            calendars: (res.items ?? []).map((c) => ({
              id: c.id,
              name: c.summaryOverride ?? c.summary,
              ...(c.primary ? { primary: true } : {}),
              time_zone: c.timeZone,
              access_role: c.accessRole,
            })),
          };
        }),
    }),

    list_events: tool({
      description:
        "List a calendar's events between time_min and time_max, ordered by start time (recurring events are expanded to their instances). Use query to text-search title, description, location and attendees; use get_event to read one in full.",
      inputSchema: z.object({
        calendar_id: calendarId(),
        time_min: z
          .string()
          .min(1)
          .describe('RFC 3339 start of the window, e.g. "2026-07-13T00:00:00+02:00"'),
        time_max: z.string().min(1).describe("RFC 3339 end of the window (exclusive)"),
        query: z.string().optional().describe("Free-text filter"),
        max_results: z.number().int().min(1).max(MAX_EVENT_RESULTS).default(25),
      }),
      execute: ({ calendar_id, time_min, time_max, query, max_results }) =>
        run(async () => {
          const params = new URLSearchParams({
            timeMin: time_min,
            timeMax: time_max,
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: String(max_results),
          });
          if (query) params.set("q", query);
          const res = await calendarFetch<{ items?: CalendarEvent[] }>(
            userId,
            `/calendars/${encodeURIComponent(calendar_id)}/events?${params}`
          );
          const events = (res.items ?? []).map(summarizeEvent);
          if (events.length === 0) return { events, note: "No events in this window." };
          return { events };
        }),
    }),

    get_event: tool({
      description:
        "Read one calendar event in full (description, attendees and their responses, recurrence, links) by event_id from list_events.",
      inputSchema: z.object({
        calendar_id: calendarId(),
        event_id: z.string().min(1),
      }),
      execute: ({ calendar_id, event_id }) =>
        run(async () =>
          fullEvent(
            await calendarFetch<CalendarEvent>(
              userId,
              `/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(event_id)}`
            )
          )
        ),
    }),

    find_free_time: tool({
      description:
        "Look up the busy intervals of one or more calendars between time_min and time_max — the gaps between them are free. Use it to find an open slot before proposing or creating an event.",
      inputSchema: z.object({
        time_min: z.string().min(1).describe("RFC 3339 start of the window"),
        time_max: z.string().min(1).describe("RFC 3339 end of the window"),
        calendar_ids: z.array(z.string().min(1)).min(1).default(["primary"]),
      }),
      execute: ({ time_min, time_max, calendar_ids }) =>
        run(async () => {
          const res = await calendarFetch<{
            calendars?: Record<
              string,
              { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }
            >;
          }>(userId, "/freeBusy", {
            method: "POST",
            body: JSON.stringify({
              timeMin: time_min,
              timeMax: time_max,
              items: calendar_ids.map((id) => ({ id })),
            }),
          });
          return {
            busy: Object.fromEntries(
              calendar_ids.map((id) => {
                const entry = res.calendars?.[id];
                if (entry?.errors?.length) return [id, { error: "calendar not accessible" }];
                return [id, entry?.busy ?? []];
              })
            ),
          };
        }),
    }),

    create_event: tool({
      description:
        "Create an event on the user's calendar. All-day events use bare dates with an exclusive end (a one-day event on the 12th runs 2026-07-12 to 2026-07-13). Listing attendees emails them an invitation unless notify_attendees is false.",
      inputSchema: z.object({
        calendar_id: calendarId(),
        summary: z.string().min(1).describe("Event title"),
        start: z.string().min(1).describe(eventTimeDescription),
        end: z.string().min(1).describe(eventTimeDescription),
        time_zone: z
          .string()
          .optional()
          .describe('IANA time zone applied to offset-less datetimes, e.g. "Europe/Amsterdam"'),
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z.array(z.string().min(3)).optional().describe("Attendee email addresses"),
        recurrence: z
          .array(z.string().min(1))
          .optional()
          .describe('RRULE lines for a recurring event, e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO"'),
        notify_attendees: z.boolean().default(true),
      }),
      execute: ({
        calendar_id,
        summary,
        start,
        end,
        time_zone,
        description,
        location,
        attendees,
        recurrence,
        notify_attendees,
      }) =>
        run(async () => {
          const event = await calendarFetch<CalendarEvent>(
            userId,
            `/calendars/${encodeURIComponent(calendar_id)}/events?sendUpdates=${notify_attendees ? "all" : "none"}`,
            {
              method: "POST",
              body: JSON.stringify({
                summary,
                start: toEventTime(start, time_zone),
                end: toEventTime(end, time_zone),
                ...(description ? { description } : {}),
                ...(location ? { location } : {}),
                ...(attendees?.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
                ...(recurrence?.length ? { recurrence } : {}),
              }),
            }
          );
          return { event_id: event.id, link: event.htmlLink, note: "Event created." };
        }),
    }),

    update_event: tool({
      description:
        "Modify an existing event: only the fields you pass change. attendees replaces the whole attendee list — include everyone who should stay invited. Attendees are notified of the change unless notify_attendees is false.",
      inputSchema: z.object({
        calendar_id: calendarId(),
        event_id: z.string().min(1),
        summary: z.string().min(1).optional(),
        start: z.string().min(1).optional().describe(eventTimeDescription),
        end: z.string().min(1).optional().describe(eventTimeDescription),
        time_zone: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z
          .array(z.string().min(3))
          .optional()
          .describe("Full replacement attendee list (email addresses)"),
        recurrence: z.array(z.string().min(1)).optional(),
        notify_attendees: z.boolean().default(true),
      }),
      execute: ({
        calendar_id,
        event_id,
        summary,
        start,
        end,
        time_zone,
        description,
        location,
        attendees,
        recurrence,
        notify_attendees,
      }) =>
        run(async () => {
          const patch: Record<string, unknown> = {
            ...(summary !== undefined ? { summary } : {}),
            ...(start !== undefined ? { start: toEventTime(start, time_zone) } : {}),
            ...(end !== undefined ? { end: toEventTime(end, time_zone) } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(location !== undefined ? { location } : {}),
            ...(attendees ? { attendees: attendees.map((email) => ({ email })) } : {}),
            ...(recurrence ? { recurrence } : {}),
          };
          if (Object.keys(patch).length === 0) {
            throw new Error("Pass at least one field to change.");
          }
          const event = await calendarFetch<CalendarEvent>(
            userId,
            `/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(event_id)}?sendUpdates=${notify_attendees ? "all" : "none"}`,
            { method: "PATCH", body: JSON.stringify(patch) }
          );
          return { event_id: event.id, note: "Event updated." };
        }),
    }),

    delete_event: tool({
      description:
        "Delete an event from the user's calendar. Attendees are notified of the cancellation unless notify_attendees is false.",
      inputSchema: z.object({
        calendar_id: calendarId(),
        event_id: z.string().min(1),
        notify_attendees: z.boolean().default(true),
      }),
      execute: ({ calendar_id, event_id, notify_attendees }) =>
        run(async () => {
          await calendarFetch<void>(
            userId,
            `/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(event_id)}?sendUpdates=${notify_attendees ? "all" : "none"}`,
            { method: "DELETE" }
          );
          return { ok: true, note: "Event deleted." };
        }),
    }),

    respond_to_event: tool({
      description:
        "Set the user's own attendance on an event they were invited to: accepted, declined or tentative. The organizer sees the response.",
      inputSchema: z.object({
        calendar_id: calendarId(),
        event_id: z.string().min(1),
        response: z.enum(["accepted", "declined", "tentative"]),
      }),
      execute: ({ calendar_id, event_id, response }) =>
        run(async () => {
          const path = `/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(event_id)}`;
          const event = await calendarFetch<CalendarEvent>(userId, path);
          // The response lives on the user's own attendee entry, and patching
          // `attendees` replaces the whole list — so send it back intact with
          // only that entry changed.
          const attendees = event.attendees ?? [];
          if (!attendees.some((a) => a.self)) {
            throw new Error(
              "The user is not an attendee of this event; only received invitations can be responded to."
            );
          }
          await calendarFetch<CalendarEvent>(userId, `${path}?sendUpdates=all`, {
            method: "PATCH",
            body: JSON.stringify({
              attendees: attendees.map((a) =>
                a.self ? { ...a, responseStatus: response } : a
              ),
            }),
          });
          return { ok: true, note: `Marked as ${response}.` };
        }),
    }),
  };
}

// The "target" of a call, for approval overrides — the attendee emails, since
// contacting people (invitations, change notifications) is the outward-facing
// part of an event write. Calls without attendees get a sentinel target rather
// than none: an empty list would store a tool-wide wildcard, silently covering
// future invite-sending calls the user never approved.
export const CALENDAR_NO_ATTENDEES_TARGET = "(no attendees)";

function attendeeTargets(input: unknown): string[] {
  const { attendees } = input as { attendees?: string[] };
  const emails = (attendees ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean);
  return emails.length > 0 ? emails : [CALENDAR_NO_ATTENDEES_TARGET];
}

const calendarApprovalTargets: Record<string, (input: unknown) => string[]> = {
  create_event: attendeeTargets,
  update_event: attendeeTargets,
};

/** Approval targets for one call: string list, or null when the tool is untargeted. */
export function googleCalendarApprovalTargetsFor(toolName: string, input: unknown): string[] | null {
  return calendarApprovalTargets[toolName]?.(input) ?? null;
}

/**
 * The Google Calendar toolset for a user, filtered by the per-agent permission
 * map — catalog defaults, "ask" gating and headless behavior per
 * `filterConnectorTools` (shared.ts).
 */
export function buildGoogleCalendarTools(
  userId: string,
  permissions?: Record<string, ToolPermissionLevel>,
  approval?: { agentId: string } | "allow"
): ToolSet {
  return filterConnectorTools({
    connector: "google-calendar",
    userId,
    tools: allCalendarTools(userId),
    toolInfo: googleCalendarToolInfo,
    permissions,
    approval,
    targetsFor: googleCalendarApprovalTargetsFor,
  });
}

// The Calendar system-prompt section, phrased for the toolset actually offered
// (write tools default to "ask", so headless runs usually get only the read
// tools). Stable per (user, agent, settings), so the KV-cache prefix rule
// holds.
export function googleCalendarPromptFor(tools: ToolSet): string {
  const writeTools = ["create_event", "update_event", "delete_event"];
  const writeLine = writeTools.some((name) => name in tools)
    ? "- create_event / update_event / delete_event change the user's real calendar immediately, and attendees are emailed about it unless notify_attendees is false. Confirm details (time zone included) before touching events that have other attendees."
    : null;
  const respondLine =
    "respond_to_event" in tools
      ? "- respond_to_event sets the user's own attendance (accepted / declined / tentative) on an invitation."
      : null;
  return [
    "## Google Calendar",
    '- You are connected to the user\'s Google Calendar. list_events shows a time window (list_calendars for ids beyond "primary"); get_event reads one; find_free_time returns busy intervals across calendars — the gaps between them are free.',
    '- Timed events use RFC 3339 datetimes (UTC offset or time_zone); all-day events use bare YYYY-MM-DD dates with an exclusive end date. Resolve relative dates ("tomorrow", "next Tuesday") with the getDate tool before calling calendar tools — never guess the current date.',
    writeLine,
    respondLine,
  ]
    .filter(Boolean)
    .join("\n");
}
