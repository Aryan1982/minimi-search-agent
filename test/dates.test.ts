import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDates } from "../src/dates.ts";

const TZ = "Asia/Kolkata";
// Tuesday 10 November 2026, 14:30 in Kolkata.
const TUESDAY = new Date("2026-11-10T09:00:00Z");
// Thursday 12 November 2026.
const THURSDAY = new Date("2026-11-12T09:00:00Z");

/** Each reference as "from..to" windows, primary first. */
function windows(text: string, now = TUESDAY, tz = TZ): string[][] {
  return resolveDates(text, now, tz).map((ref) => ref.windows.map((w) => (w.from === w.to ? w.from : `${w.from}..${w.to}`)));
}

test("the three queries from the brief", () => {
  assert.deepEqual(windows("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?"), [
    ["2026-11-09"],
  ]);
  assert.deepEqual(windows("What did I ask you on 3 November? Is your answer still correct today?"), [["2026-11-03"]]);
  assert.deepEqual(windows("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"), [["2026-11-03"]]);
});

test("a weekday always resolves backwards, never to the coming one", () => {
  assert.deepEqual(windows("on Friday you recommended a laptop"), [["2026-11-06"]]);
  assert.deepEqual(windows("what did we discuss on Wednesday"), [["2026-11-04"]]);
});

test("'last Tuesday' said mid-week offers both readings, nearest first", () => {
  assert.deepEqual(windows("Last Tuesday I asked about Postgres", THURSDAY), [["2026-11-10", "2026-11-03"]]);
});

test("a weekday named on that same weekday may also mean today", () => {
  assert.deepEqual(windows("on Tuesday we compared CRMs"), [["2026-11-03", "2026-11-10"]]);
});

test("dates without a year resolve to the most recent past occurrence", () => {
  assert.deepEqual(windows("what did I ask on 25 December"), [["2025-12-25"]]);
  assert.deepEqual(windows("what did I ask on Nov 3rd"), [["2026-11-03"]]);
  assert.deepEqual(windows("what did I ask on 3 November 2025"), [["2025-11-03"]]);
});

test("relative days", () => {
  assert.deepEqual(windows("yesterday you told me about Neon"), [["2026-11-09"]]);
  assert.deepEqual(windows("the day before yesterday we talked"), [["2026-11-08"]]);
  assert.deepEqual(windows("what did I ask you earlier today"), [["2026-11-10"]]);
});

test("periods become ranges", () => {
  assert.deepEqual(windows("last week you compared three hosts"), [["2026-11-02..2026-11-08", "2026-11-03..2026-11-09"]]);
  assert.deepEqual(windows("what did we cover last month"), [["2026-10-01..2026-10-31"]]);
  assert.deepEqual(windows("a few days ago I asked about Stripe"), [["2026-11-03..2026-11-09"]]);
  assert.deepEqual(windows("two weeks ago we talked about hosting"), [["2026-10-24..2026-10-30"]]);
  assert.deepEqual(windows("what did I ask in October"), [["2026-10-01..2026-10-31"]]);
  assert.deepEqual(windows("what did I ask in December"), [["2025-12-01..2025-12-31"]]);
});

test("the user's timezone decides what 'yesterday' is", () => {
  // 20:00 UTC on the 10th is already the 11th in Kolkata and still the 10th in Los Angeles.
  const late = new Date("2026-11-10T20:00:00Z");
  assert.deepEqual(windows("yesterday we talked", late, "Asia/Kolkata"), [["2026-11-10"]]);
  assert.deepEqual(windows("yesterday we talked", late, "America/Los_Angeles"), [["2026-11-09"]]);
});

test("words that only look like dates are ignored", () => {
  assert.deepEqual(windows("May I ask about the sun and the march of progress?"), []);
  assert.deepEqual(windows("What is the best CRM for a 20-person team?"), []);
  assert.deepEqual(windows("Has any pricing changed since then?"), []);
});

test("future dates are not references to past conversations", () => {
  assert.deepEqual(windows("what did I ask on 3 November 2027"), []);
});
