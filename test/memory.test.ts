import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { localDate } from "../src/clock.ts";
import * as db from "../src/db.ts";
import { recall, recheckSearches, renderContext } from "../src/memory.ts";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-10T09:00:00Z"); // Tuesday 10 November 2026, 14:30 in Kolkata

function store(conversationId: string, iso: string, question: string, answer: string): number {
  const at = new Date(iso);
  db.upsertConversation(conversationId, question, at.getTime());
  const id = db.insertTurn({ conversationId, at: at.getTime(), localDate: localDate(at, TZ), tz: TZ, question, context: "" });
  db.completeTurn(id, answer, [{ n: 1, url: "https://example.com/pricing", title: "Pricing" }]);
  return id;
}

const postgres = store(
  "a",
  "2026-11-03T05:00:00Z",
  "Which managed Postgres hosting is cheapest for a small SaaS?",
  "Neon Launch is $19/month, Supabase Pro is $25/month, RDS db.t4g.micro is about $13/month [1].",
);
const birthday = store("a", "2026-11-03T06:00:00Z", "Gift ideas for my sister's birthday?", "A film camera, a pottery class.");
const crm = store(
  "b",
  "2026-11-06T07:00:00Z",
  "Shortlist 5 CRM tools for a 20-person sales team",
  "HubSpot, Pipedrive, Close, Attio and Zoho CRM. Pipedrive Advanced is $34/user/month [1].",
);
db.setExtraction(
  postgres,
  "Compared managed Postgres hosts on price.",
  "Neon, Supabase, Amazon RDS",
  [{ entity: "Neon", attribute: "Launch plan price", value: "$19/month", sourceUrl: "https://neon.tech/pricing" }],
  [
    { subject: "Neon", query: "Neon pricing Launch plan", domain: "neon.tech" },
    { subject: "Amazon RDS", query: "Amazon RDS for PostgreSQL pricing", domain: "" },
  ],
);
// A turn that never got its answer must not be remembered.
db.insertTurn({ conversationId: "b", at: Date.parse("2026-11-09T07:00:00Z"), localDate: "2026-11-09", tz: TZ, question: "Postgres?", context: "" });

const ids = (turns: { id: number }[]) => turns.map((t) => t.id);

test("a date plus a topic recalls that day's exchange on that topic first", () => {
  const r = recall("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", NOW, TZ);
  assert.equal(r.refersToHistory, true);
  assert.deepEqual(r.dates.map((d) => [d.window.from, d.found]), [["2026-11-03", true]]);
  assert.deepEqual(ids(r.exchanges), [postgres, birthday]);
});

test("a date alone recalls everything asked that day, in order", () => {
  const r = recall("What did I ask you on 3 November? Is your answer still correct today?", NOW, TZ);
  assert.deepEqual(ids(r.exchanges), [postgres, birthday]);
});

test("a date with nothing stored says so and offers the nearest exchange on the topic", () => {
  const r = recall("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing?", NOW, TZ);
  assert.deepEqual(r.dates.map((d) => [d.window.from, d.found]), [["2026-11-09", false]]);
  assert.equal(r.exchanges[0]?.id, crm);
  const context = renderContext(r, NOW, TZ);
  assert.match(context, /resolves to Monday 9 November 2026\. No exchange is stored for that date\./);
  assert.match(context, /closest by topic, from other dates/);
  assert.match(context, /Friday 6 November 2026/);
});

test("an ambiguous weekday picks the reading that holds the topic", () => {
  // Said on Thursday 12 November: the nearest Tuesday (the 10th) is empty, the one before has Postgres.
  const r = recall("Last Tuesday I asked about Postgres hosting", new Date("2026-11-12T09:00:00Z"), TZ);
  assert.deepEqual(r.dates.map((d) => [d.window.from, d.found]), [["2026-11-03", true]]);
  assert.equal(r.exchanges[0]?.id, postgres);
});

test("a reference to history without a date recalls by topic", () => {
  const r = recall("Remember the CRM shortlist? Which one did you say was cheapest?", NOW, TZ);
  assert.equal(r.exchanges[0]?.id, crm);
});

test("a reference to history that matches nothing lists what is stored instead of inventing", () => {
  const r = recall("What did you tell me about kubernetes autoscaling last time?", NOW, TZ);
  assert.deepEqual(r.exchanges, []);
  assert.equal(r.mentions.length, 3);
});

test("an ordinary question pulls no full exchanges and no weakly related history", () => {
  const unrelated = recall("What is the capital of Australia?", NOW, TZ);
  assert.deepEqual([unrelated.exchanges, unrelated.mentions], [[], []]);
  assert.doesNotMatch(renderContext(unrelated, NOW, TZ), /<memory>/);

  // A dated question about the world, not about us: the empty date is not reported as missing memory.
  const world = recall("What did Apple announce last Tuesday?", NOW, TZ);
  assert.deepEqual([world.dates, world.exchanges], [[], []]);

  const related = recall("Is Supabase or Neon better for Postgres branching?", NOW, TZ);
  assert.deepEqual([ids(related.exchanges), ids(related.mentions)], [[], [postgres]]);
});

test("turns already in the conversation history are not recalled a second time", () => {
  const r = recall("Last Tuesday I asked you about Postgres hosting", NOW, TZ, new Set([postgres]));
  assert.deepEqual(ids(r.exchanges), [birthday]);
});

test("asking whether a recalled answer still holds runs its stored re-check plan", () => {
  const changed = "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?";
  assert.deepEqual(recheckSearches(changed, recall(changed, NOW, TZ), NOW), [
    { query: "Neon pricing Launch plan", domains: ["neon.tech"], recency: null },
    { query: "Amazon RDS for PostgreSQL pricing", domains: [], recency: null },
  ]);

  // Asking what shipped adds a news search per subject, reaching back past the day we spoke:
  // seven days and a few hours ago is outside "the last week", so the window is a month.
  const shipped = "Last Tuesday I asked you about Postgres hosting. Has anything changed or shipped since?";
  assert.deepEqual(recheckSearches(shipped, recall(shipped, NOW, TZ), NOW).slice(2), [
    { query: "Neon new release announcement", domains: [], recency: "month" },
    { query: "Amazon RDS new release announcement", domains: [], recency: "month" },
  ]);

  // Recalling is not re-checking, and neither is a question about the world.
  const listing = "What did I ask you on 3 November?";
  assert.deepEqual(recheckSearches(listing, recall(listing, NOW, TZ), NOW), []);
  const world = "Has Postgres 18 changed anything about indexing?";
  assert.deepEqual(recheckSearches(world, recall(world, NOW, TZ), NOW), []);
});

test("the context block carries the past answer, its sources, its claims and its age", () => {
  const context = renderContext(recall("Last Tuesday I asked you about Postgres hosting", NOW, TZ), NOW, TZ);
  assert.match(context, /Now: Tuesday 10 November 2026, 14:30 \(Asia\/Kolkata\)/);
  assert.match(context, /<exchange date="Tuesday 3 November 2026, 10:30" age="7 days ago">/);
  assert.match(context, /Supabase Pro is \$25\/month/);
  assert.match(context, /\[1\] Pricing https:\/\/example\.com\/pricing/);
  assert.match(context, /- Neon \| Launch plan price \| \$19\/month \| https:\/\/neon\.tech\/pricing/);
});
