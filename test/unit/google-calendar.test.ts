import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleCalendarTools,
  CALENDAR_NO_ATTENDEES_TARGET,
  googleCalendarApprovalTargetsFor,
  googleCalendarToolInfo,
  toEventTime,
} from "../../lib/agent/connectors/google-calendar";
import { buildConnectorTools } from "../../lib/agent/connectors";
import { setConnectorTokens, upsertConnectorSetting } from "../../lib/db/connectors";
import { addToolApprovals } from "../../lib/db/tool-approvals";
import { closeDb, makeUser, makeUserWithAgent, resetDb } from "../helpers/db";
import type { ConnectorTokens } from "../../lib/global/schema";

beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(closeDb);

const CREDS = { clientId: "client-id", clientSecret: "client-secret" };

function tokens(overrides: Partial<ConnectorTokens> = {}): ConnectorTokens {
  return {
    refreshToken: "refresh-1",
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 3600_000,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    email: "user@gmail.com",
    ...overrides,
  };
}

async function connectedUser() {
  const { user, agent } = await makeUserWithAgent("Cal");
  await upsertConnectorSetting(user.id, "google-calendar", CREDS);
  await setConnectorTokens(user.id, "google-calendar", tokens(), "connected");
  return { user, agent };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("event time routing", () => {
  it("routes bare dates to all-day and datetimes to timed", () => {
    expect(toEventTime("2026-07-12")).toEqual({ date: "2026-07-12" });
    expect(toEventTime("2026-07-13T15:00:00+02:00")).toEqual({
      dateTime: "2026-07-13T15:00:00+02:00",
    });
    expect(toEventTime("2026-07-13T15:00:00", "Europe/Amsterdam")).toEqual({
      dateTime: "2026-07-13T15:00:00",
      timeZone: "Europe/Amsterdam",
    });
    // A time zone never leaks onto all-day events.
    expect(toEventTime("2026-07-12", "Europe/Amsterdam")).toEqual({ date: "2026-07-12" });
  });
});

describe("approval targets", () => {
  it("targets attendee emails, lowercased and trimmed", () => {
    expect(
      googleCalendarApprovalTargetsFor("create_event", {
        attendees: [" Alice@Example.com ", "bob@example.com"],
      })
    ).toEqual(["alice@example.com", "bob@example.com"]);
    expect(googleCalendarApprovalTargetsFor("update_event", { attendees: ["a@x.com"] })).toEqual([
      "a@x.com",
    ]);
  });

  it("uses a sentinel for attendee-less calls so approvals never store a wildcard", () => {
    expect(googleCalendarApprovalTargetsFor("create_event", {})).toEqual([
      CALENDAR_NO_ATTENDEES_TARGET,
    ]);
    expect(googleCalendarApprovalTargetsFor("update_event", { attendees: [] })).toEqual([
      CALENDAR_NO_ATTENDEES_TARGET,
    ]);
  });

  it("leaves the other tools untargeted", () => {
    expect(googleCalendarApprovalTargetsFor("delete_event", { event_id: "e1" })).toBeNull();
    expect(googleCalendarApprovalTargetsFor("respond_to_event", {})).toBeNull();
    expect(googleCalendarApprovalTargetsFor("list_events", {})).toBeNull();
  });
});

describe("permission filtering", () => {
  it('write tools default to "ask": headless runs get only the read tools', () => {
    const headless = buildGoogleCalendarTools("user-1");
    expect(Object.keys(headless).sort()).toEqual(
      googleCalendarToolInfo
        .filter((t) => t.kind === "read")
        .map((t) => t.name)
        .sort()
    );
    expect(headless.create_event).toBeUndefined();

    // An explicit "allow" overrides the default, even headless.
    const allowed = buildGoogleCalendarTools("user-1", { create_event: "allow" });
    expect(allowed.create_event).toBeDefined();
    expect(allowed.create_event?.needsApproval).toBeUndefined();

    // headless "allow" policy (cron askPolicy) runs "ask" tools unattended.
    const cron = buildGoogleCalendarTools("user-1", { get_event: "deny" }, "allow");
    expect(cron.delete_event).toBeDefined();
    expect(cron.delete_event?.needsApproval).toBeUndefined();
    expect(cron.get_event).toBeUndefined();
  });

  it("interactive runs gate write tools with needsApproval keyed by attendee targets", async () => {
    const { user, agent } = await makeUserWithAgent("Gate");
    const tools = buildGoogleCalendarTools(user.id, undefined, { agentId: agent.id });
    expect(tools.list_events?.needsApproval).toBeUndefined();
    const needsApproval = tools.create_event?.needsApproval as (input: unknown) => Promise<boolean>;
    expect(typeof needsApproval).toBe("function");

    const noAttendees = { calendar_id: "primary", summary: "Focus", start: "2026-07-14", end: "2026-07-15" };
    expect(await needsApproval(noAttendees)).toBe(true);

    // Approving the attendee-less shape covers only attendee-less calls: the
    // sentinel target never spills over to invite-sending ones.
    await addToolApprovals({
      userId: user.id,
      agentId: agent.id,
      connector: "google-calendar",
      tool: "create_event",
      targets: [CALENDAR_NO_ATTENDEES_TARGET],
    });
    expect(await needsApproval(noAttendees)).toBe(false);
    expect(await needsApproval({ ...noAttendees, attendees: ["a@x.com"] })).toBe(true);
  });
});

describe("calendar tools against a stubbed API", () => {
  it("list_events queries the window expanded and summarizes results", async () => {
    const { user } = await connectedUser();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        items: [
          {
            id: "e1",
            status: "confirmed",
            summary: "Standup",
            start: { dateTime: "2026-07-13T09:00:00+02:00" },
            end: { dateTime: "2026-07-13T09:15:00+02:00" },
            organizer: { email: "boss@example.com" },
            attendees: [
              { email: "user@gmail.com", responseStatus: "accepted", self: true },
              { email: "boss@example.com", responseStatus: "accepted" },
            ],
          },
          {
            id: "e2",
            summary: "Holiday",
            start: { date: "2026-07-14" },
            end: { date: "2026-07-15" },
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const tools = buildGoogleCalendarTools(user.id);
    const result = await (tools.list_events as any).execute(
      {
        calendar_id: "primary",
        time_min: "2026-07-13T00:00:00+02:00",
        time_max: "2026-07-20T00:00:00+02:00",
        max_results: 25,
      },
      {}
    );

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/calendars/primary/events?");
    expect(url).toContain("timeMin=2026-07-13T00%3A00%3A00%2B02%3A00");
    expect(url).toContain("singleEvents=true");
    expect(url).toContain("orderBy=startTime");
    expect(url).toContain("maxResults=25");

    expect(result.events).toEqual([
      {
        event_id: "e1",
        summary: "Standup",
        start: "2026-07-13T09:00:00+02:00",
        end: "2026-07-13T09:15:00+02:00",
        organizer: "boss@example.com",
        attendees: [
          { email: "user@gmail.com", response: "accepted", self: true },
          { email: "boss@example.com", response: "accepted" },
        ],
      },
      {
        event_id: "e2",
        summary: "Holiday",
        start: "2026-07-14",
        end: "2026-07-15",
        all_day: true,
      },
    ]);
  });

  it("find_free_time posts the calendars and maps busy intervals and errors", async () => {
    const { user } = await connectedUser();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        calendars: {
          primary: { busy: [{ start: "2026-07-13T09:00:00Z", end: "2026-07-13T10:00:00Z" }] },
          "team@group.calendar.google.com": { errors: [{ reason: "notFound" }] },
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const tools = buildGoogleCalendarTools(user.id);
    const result = await (tools.find_free_time as any).execute(
      {
        time_min: "2026-07-13T00:00:00Z",
        time_max: "2026-07-14T00:00:00Z",
        calendar_ids: ["primary", "team@group.calendar.google.com"],
      },
      {}
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toEqual({
      timeMin: "2026-07-13T00:00:00Z",
      timeMax: "2026-07-14T00:00:00Z",
      items: [{ id: "primary" }, { id: "team@group.calendar.google.com" }],
    });
    expect(result.busy.primary).toEqual([
      { start: "2026-07-13T09:00:00Z", end: "2026-07-13T10:00:00Z" },
    ]);
    expect(result.busy["team@group.calendar.google.com"]).toEqual({
      error: "calendar not accessible",
    });
  });

  it("create_event posts timed and all-day shapes with the notify flag", async () => {
    const { user } = await connectedUser();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: "new-1", htmlLink: "https://calendar.google.com/event?eid=x" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const tools = buildGoogleCalendarTools(user.id, { create_event: "allow" });
    const result = await (tools.create_event as any).execute(
      {
        calendar_id: "primary",
        summary: "Dinner",
        start: "2026-07-18T19:00:00",
        end: "2026-07-18T21:00:00",
        time_zone: "Europe/Amsterdam",
        location: "Da Mario",
        attendees: ["alice@example.com"],
        notify_attendees: true,
      },
      {}
    );
    expect(result).toEqual({
      event_id: "new-1",
      link: "https://calendar.google.com/event?eid=x",
      note: "Event created.",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/calendars/primary/events?sendUpdates=all");
    expect(JSON.parse(String(init.body))).toEqual({
      summary: "Dinner",
      start: { dateTime: "2026-07-18T19:00:00", timeZone: "Europe/Amsterdam" },
      end: { dateTime: "2026-07-18T21:00:00", timeZone: "Europe/Amsterdam" },
      location: "Da Mario",
      attendees: [{ email: "alice@example.com" }],
    });

    // All-day + silent: bare dates and sendUpdates=none.
    await (tools.create_event as any).execute(
      {
        calendar_id: "primary",
        summary: "Trip",
        start: "2026-08-01",
        end: "2026-08-03",
        notify_attendees: false,
      },
      {}
    );
    const [url2, init2] = fetchMock.mock.calls[1];
    expect(String(url2)).toContain("sendUpdates=none");
    expect(JSON.parse(String(init2.body))).toEqual({
      summary: "Trip",
      start: { date: "2026-08-01" },
      end: { date: "2026-08-03" },
    });
  });

  it("update_event patches only the passed fields and rejects empty patches", async () => {
    const { user } = await connectedUser();
    const fetchMock = vi.fn(async () => jsonResponse({ id: "e1" }));
    vi.stubGlobal("fetch", fetchMock);

    const tools = buildGoogleCalendarTools(user.id, { update_event: "allow" });
    const result = await (tools.update_event as any).execute(
      {
        calendar_id: "primary",
        event_id: "e1",
        location: "Room 2",
        notify_attendees: false,
      },
      {}
    );
    expect(result).toEqual({ event_id: "e1", note: "Event updated." });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/calendars/primary/events/e1?sendUpdates=none");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ location: "Room 2" });

    const empty = await (tools.update_event as any).execute(
      { calendar_id: "primary", event_id: "e1", notify_attendees: true },
      {}
    );
    expect(empty.error).toContain("at least one field");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("delete_event handles the empty 204 response", async () => {
    const { user } = await connectedUser();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const tools = buildGoogleCalendarTools(user.id, { delete_event: "allow" });
    const result = await (tools.delete_event as any).execute(
      { calendar_id: "primary", event_id: "e1", notify_attendees: true },
      {}
    );
    expect(result).toEqual({ ok: true, note: "Event deleted." });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/events/e1?sendUpdates=all");
    expect(init.method).toBe("DELETE");
  });

  it("respond_to_event patches the user's own attendee entry, keeping the rest", async () => {
    const { user } = await connectedUser();
    const fetchMock = vi.fn(async (url: any, init?: RequestInit) => {
      if (!init?.method) {
        return jsonResponse({
          id: "e1",
          attendees: [
            { email: "boss@example.com", responseStatus: "accepted", organizer: true },
            { email: "user@gmail.com", responseStatus: "needsAction", self: true },
          ],
        });
      }
      return jsonResponse({ id: "e1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tools = buildGoogleCalendarTools(user.id, { respond_to_event: "allow" });
    const result = await (tools.respond_to_event as any).execute(
      { calendar_id: "primary", event_id: "e1", response: "accepted" },
      {}
    );
    expect(result).toEqual({ ok: true, note: "Marked as accepted." });

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(String(patch![0])).toContain("sendUpdates=all");
    expect(JSON.parse(String(patch![1]!.body))).toEqual({
      attendees: [
        { email: "boss@example.com", responseStatus: "accepted", organizer: true },
        { email: "user@gmail.com", responseStatus: "accepted", self: true },
      ],
    });
  });

  it("respond_to_event errors when the user is not an attendee", async () => {
    const { user } = await connectedUser();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "e1", attendees: [{ email: "other@example.com" }] }))
    );
    const tools = buildGoogleCalendarTools(user.id, { respond_to_event: "allow" });
    const result = await (tools.respond_to_event as any).execute(
      { calendar_id: "primary", event_id: "e1", response: "declined" },
      {}
    );
    expect(result.error).toContain("not an attendee");
  });

  it("surfaces auth problems as a tool error result instead of throwing", async () => {
    const user = await makeUser("Nova");
    const tools = buildGoogleCalendarTools(user.id);
    const result = await (tools.list_calendars as any).execute({}, {});
    expect(result.error).toContain("not connected");
  });
});

describe("buildConnectorTools with calendar", () => {
  it("offers the calendar read tools and prompt when connected (headless)", async () => {
    const { user, agent } = await connectedUser();
    const result = await buildConnectorTools({ userId: user.id, agentId: agent.id });
    expect(result.prompt).toContain("## Google Calendar");
    expect(result.prompt).not.toContain("create_event");
    expect(result.tools.list_events).toBeDefined();
    expect(result.tools.create_event).toBeUndefined();
  });

  it("merges tools and prompts when gmail and calendar are both connected", async () => {
    const { user, agent } = await connectedUser();
    await upsertConnectorSetting(user.id, "gmail", CREDS);
    await setConnectorTokens(user.id, "gmail", tokens(), "connected");

    const result = await buildConnectorTools({
      userId: user.id,
      agentId: agent.id,
      interactive: true,
    });
    expect(result.tools.search_threads).toBeDefined();
    expect(result.tools.list_events).toBeDefined();
    expect(result.tools.create_event?.needsApproval).toBeDefined();
    expect(result.prompt).toContain("## Gmail");
    expect(result.prompt).toContain("## Google Calendar");
  });
});
