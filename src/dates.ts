import * as chrono from "chrono-node";
import { addDays, formatDate, localDate, tzOffsetMinutes } from "./clock.ts";

// Turns "last Tuesday", "on Monday", "3 November" into civil-date windows in the user's
// timezone. This runs in code, before the model: a model asked to do calendar arithmetic gets
// it wrong some of the time, and a wrong date silently recalls the wrong conversation.
//
// Every phrase resolves into the past. chrono-node finds the phrases; the policy for which
// date a phrase means is ours, because chrono resolves a bare "Friday" forward.

export interface DateWindow {
  from: string;
  to: string;
  label: string;
}

export interface DateRef {
  /** The phrase as the user wrote it. */
  text: string;
  /** Most likely reading first. Later entries are other honest readings of the same phrase. */
  windows: DateWindow[];
}

function window(from: string, to: string = from): DateWindow {
  return { from, to, label: from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}` };
}

function monthWindow(year: number, month: number): DateWindow {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return window(first, addDays(next, -1));
}

// Periods chrono collapses to a single day ("last week" becomes "7 days ago").
const PERIODS: { pattern: RegExp; resolve: (today: string) => DateWindow[] }[] = [
  {
    pattern: /\b(?:last|previous|past)\s+week\b/gi,
    resolve: (today) => {
      const monday = mondayOf(today);
      // "Last week" is the previous Monday-to-Sunday; some people mean the last seven days.
      return [window(addDays(monday, -7), addDays(monday, -1)), window(addDays(today, -7), addDays(today, -1))];
    },
  },
  { pattern: /\bthis\s+week\b/gi, resolve: (today) => [window(mondayOf(today), today)] },
  {
    pattern: /\b(?:last|previous|past)\s+month\b/gi,
    resolve: (today) => {
      const year = Number(today.slice(0, 4));
      const month = Number(today.slice(5, 7));
      return [month === 1 ? monthWindow(year - 1, 12) : monthWindow(year, month - 1)];
    },
  },
  { pattern: /\bthis\s+month\b/gi, resolve: (today) => [window(`${today.slice(0, 8)}01`, today)] },
  {
    pattern: /\b(?:a\s+)?(?:few|couple(?:\s+of)?)\s+days\s+(?:ago|back)\b|\bthe\s+other\s+day\b/gi,
    resolve: (today) => [window(addDays(today, -7), addDays(today, -1))],
  },
];

function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

const FULL_WEEKDAY = /(?:mon|tues|wednes|thurs|fri|satur|sun)day/;
const LEADS_INTO_MONTH = /\b(?:in|during|since|last|this|early|late|mid|of)\s+$/i;

export function resolveDates(text: string, now: Date, tz: string): DateRef[] {
  const today = localDate(now, tz);
  const found: { index: number; ref: DateRef }[] = [];

  // Period phrases first; blank them out so chrono does not read them a second time.
  let rest = text;
  for (const { pattern, resolve } of PERIODS) {
    for (const m of text.matchAll(pattern)) {
      found.push({ index: m.index, ref: { text: m[0], windows: resolve(today) } });
      rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
  }

  for (const r of chrono.parse(rest, { instant: now, timezone: tzOffsetMinutes(now, tz) })) {
    const windows = readChrono(r, rest, today);
    if (windows.length > 0) found.push({ index: r.index, ref: { text: r.text, windows } });
  }

  let refs = found.sort((a, b) => a.index - b.index).map((f) => f.ref);

  // "What did I ask on 3 November? Is it still correct today?" - "today" there means now, not
  // a conversation to recall. Today only counts as a reference when it is the only one.
  const isToday = (ref: DateRef) => ref.windows[0]!.from === today;
  if (refs.some((ref) => !isToday(ref))) refs = refs.filter((ref) => !isToday(ref));

  return refs;
}

function readChrono(r: chrono.ParsedResult, text: string, today: string): DateWindow[] {
  const phrase = r.text.toLowerCase();
  const certain = (c: chrono.Component) => r.start.isCertain(c);
  const ymd = (c: chrono.ParsedComponents) =>
    `${c.get("year")}-${String(c.get("month")).padStart(2, "0")}-${String(c.get("day")).padStart(2, "0")}`;
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  let windows: DateWindow[];

  if (r.end) {
    windows = [window(ymd(r.start), ymd(r.end))];
  } else if (certain("weekday") && !certain("day")) {
    // A bare "sun" or "wed" inside a sentence is usually not a day.
    if (!FULL_WEEKDAY.test(phrase) && !/^(?:on|last|this|previous|past)\s/.test(phrase)) return [];
    const todayWeekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const back = (todayWeekday - r.start.get("weekday")! + 7) % 7 || 7;
    const latest = addDays(today, -back); // most recent one strictly before today
    if (/\b(?:last|previous|past)\b/.test(phrase)) {
      // On a Thursday, "last Tuesday" is two days ago to some speakers and nine to others.
      windows = back < 7 ? [window(latest), window(addDays(latest, -7))] : [window(latest)];
    } else {
      // Said on a Monday, "on Monday" may also mean earlier today.
      windows = back === 7 ? [window(latest), window(today)] : [window(latest)];
    }
  } else if (/\bweeks?\s+ago\b/.test(phrase)) {
    windows = [window(addDays(ymd(r.start), -3), addDays(ymd(r.start), 3))];
  } else if (/\bmonths?\s+ago\b/.test(phrase)) {
    windows = [monthWindow(r.start.get("year")!, r.start.get("month")!)];
  } else if (certain("month") && !certain("day")) {
    // "march of progress", "may I ask": a month name only counts after a word like "in".
    if (!LEADS_INTO_MONTH.test(text.slice(0, r.index)) && !/^(?:in|during|since|last|this)\s/.test(phrase)) return [];
    const m = r.start.get("month")!;
    windows = [monthWindow(certain("year") ? r.start.get("year")! : m > month ? year - 1 : year, m)];
  } else if (certain("day")) {
    let date = ymd(r.start);
    if (!certain("year") && date > today) {
      // "25 December" said in November means last year's; "the 25th" said on the 10th means last month's.
      const d = String(r.start.get("day")).padStart(2, "0");
      if (certain("month")) date = `${year - 1}-${date.slice(5)}`;
      else date = month === 1 ? `${year - 1}-12-${d}` : `${year}-${String(month - 1).padStart(2, "0")}-${d}`;
    }
    windows = [window(date)];
  } else if (/\btoday\b|\btonight\b|\bthis\s+(?:morning|afternoon|evening)\b/.test(phrase)) {
    windows = [window(today)];
  } else {
    return []; // a bare time of day, "now", and the like
  }

  // Nothing was said in the future; clip windows that run past today.
  return windows.filter((w) => w.from <= today).map((w) => (w.to > today ? window(w.from, today) : w));
}
