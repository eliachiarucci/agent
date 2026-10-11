// Wall-clock helpers for a device's timezone: the daily log's day, times shown
// to the agent, and day ranges for observation searches.

function parts(date: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
}

/** "YYYY-MM-DD" in the zone. */
export function localDate(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "HH:MM" in the zone, or "HH:MM:SS" with `seconds`. */
export function localTime(date: Date, timeZone: string, seconds = false): string {
  const p = parts(date, timeZone);
  return seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
}

/** e.g. "Sat 11 Oct 2026". */
export function localDayLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** The instant at which the zone's wall clock reads `date` ("YYYY-MM-DD") `time` ("HH:MM"). */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  // The zone's offset at a guess, applied twice so a DST change in between settles.
  let instant = wall;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(instant), timeZone);
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    instant += wall - shown;
  }
  return new Date(instant);
}

/** Start and end of a local day ("YYYY-MM-DD"). */
export function localDayRange(date: string, timeZone: string): { from: Date; to: Date } {
  const from = zonedInstant(date, "00:00", timeZone);
  const next = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + 1));
  return { from, to: new Date(zonedInstant(next.toISOString().slice(0, 10), "00:00", timeZone).getTime() - 1) };
}
