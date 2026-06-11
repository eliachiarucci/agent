import type { CronRecurrence } from "../global/schema";

export type CronSchedule = {
  // 0 = Sunday … 6 = Saturday (JS Date#getDay()); at least one entry.
  daysOfWeek: number[];
  // "HH:MM" wall clock in `timezone`.
  time: string;
  recurrence: CronRecurrence;
  // IANA timezone name.
  timezone: string;
};

// Milliseconds the given timezone is ahead of UTC at `date` (DST-aware), via
// Intl: format the instant in the zone, reinterpret those wall-clock parts as
// UTC, and diff. Avoids a date-math dependency for the one conversion we need.
function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl renders midnight as "24" with hour12: false.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

// The instant at which the given wall-clock time occurs in `timezone`. The
// offset is derived twice so a guess that lands across a DST switch is
// corrected (spring-forward gaps resolve to the post-switch offset).
function wallClockToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let offset = timezoneOffsetMs(new Date(guess), timezone);
  const corrected = timezoneOffsetMs(new Date(guess - offset), timezone);
  if (corrected !== offset) offset = corrected;
  return new Date(guess - offset);
}

// Calendar date (and weekday) of an instant as seen in `timezone`.
function dateInZone(
  date: Date,
  timezone: string
): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(date.getTime() + timezoneOffsetMs(date, timezone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

/**
 * Weekday and "HH:MM" of an instant as seen in `timezone` — for jobs created
 * from an absolute datetime ("once" reminders), whose stored schedule fields
 * are derived from that instant.
 */
export function wallClockInZone(
  date: Date,
  timezone: string
): { dayOfWeek: number; time: string } {
  const shifted = new Date(date.getTime() + timezoneOffsetMs(date, timezone));
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    dayOfWeek: shifted.getUTCDay(),
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

function parseTime(time: string): { hour: number; minute: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error(`Invalid time "${time}", expected HH:MM`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// Sunday-start week index of an instant in the schedule's timezone (epoch day
// 3 = Sunday Jan 4 1970). Biweekly schedules run on all selected days of an
// "on" week, then skip a week — week identity is what decides that.
function weekIndex(date: Date, timezone: string): number {
  const { year, month, day } = dateInZone(date, timezone);
  const epochDays = Date.UTC(year, month - 1, day) / 86_400_000;
  return Math.floor((epochDays - 3) / 7);
}

/** First occurrence of any selected weekday + time strictly after `after`. */
export function nextOccurrence(schedule: CronSchedule, after: Date): Date {
  if (schedule.daysOfWeek.length === 0) throw new Error("daysOfWeek must not be empty");
  const { hour, minute } = parseTime(schedule.time);
  const start = dateInZone(after, schedule.timezone);
  // Walk day by day from `after`'s date in the zone; 8 days always contains
  // the next matching weekday even when today's slot has already passed.
  for (let i = 0; i <= 8; i++) {
    const probe = new Date(Date.UTC(start.year, start.month - 1, start.day + i, 12));
    if (!schedule.daysOfWeek.includes(probe.getUTCDay())) continue;
    const candidate = wallClockToUtc(
      probe.getUTCFullYear(),
      probe.getUTCMonth() + 1,
      probe.getUTCDate(),
      hour,
      minute,
      schedule.timezone
    );
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  /* v8 ignore next */
  throw new Error("No occurrence found within 8 days — unreachable");
}

/**
 * The run after the one scheduled at `current`. Weekly: the next selected day.
 * Biweekly: remaining selected days of the current week still run; once the
 * week is exhausted, the next week is skipped. Monthly: the first selected day
 * that lands in a later calendar month (in the job's timezone). "once" jobs
 * delete themselves after succeeding, so this only fires when a run failed —
 * they fall through to the weekly case as a retry cadence.
 */
export function nextRunAfter(schedule: CronSchedule, current: Date): Date {
  let next = nextOccurrence(schedule, current);
  if (schedule.recurrence === "biweekly") {
    const currentWeek = weekIndex(current, schedule.timezone);
    while (
      weekIndex(next, schedule.timezone) !== currentWeek &&
      weekIndex(next, schedule.timezone) < currentWeek + 2
    ) {
      next = nextOccurrence(schedule, next);
    }
  } else if (schedule.recurrence === "monthly") {
    const startMonth = dateInZone(current, schedule.timezone);
    let probe = dateInZone(next, schedule.timezone);
    while (probe.year === startMonth.year && probe.month === startMonth.month) {
      next = nextOccurrence(schedule, next);
      probe = dateInZone(next, schedule.timezone);
    }
  }
  return next;
}
