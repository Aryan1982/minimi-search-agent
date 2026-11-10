// Every "what time is it" in the codebase goes through here, so the seed script and the evals
// can place a conversation in the past and then ask about it "today".

let offsetMs = 0;

export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

/** Pretend the current moment is `at`; time keeps ticking from there. Pass null to reset. */
export function setNow(at: Date | null): void {
  offsetMs = at ? at.getTime() - Date.now() : 0;
}

export const DEFAULT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function validTz(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

// Civil dates are "YYYY-MM-DD" strings in the user's timezone. They sort and compare as text,
// which is what makes "everything on 3 November" a plain SQL range.

export function localDate(at: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Minutes east of UTC for `tz` at instant `at` (330 for Asia/Kolkata). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** The instant at which clocks in `tz` read `time` ("10:30") on civil date `date`. */
export function atLocalTime(date: string, time: string, tz: string): Date {
  const asIfUtc = new Date(`${date}T${time}:00Z`);
  return new Date(asIfUtc.getTime() - tzOffsetMinutes(asIfUtc, tz) * 60_000);
}

/** "Tuesday 3 November 2026" */
export function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`)).replace(",", "");
}

/** "Tuesday 3 November 2026, 14:32" in the user's timezone. */
export function formatDateTime(at: Date, tz: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return `${formatDate(localDate(at, tz))}, ${time}`;
}
