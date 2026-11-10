import "../test/env.ts"; // a private in-memory database for the run
import { anthropic } from "../src/agent.ts";
import { chatTurn } from "../src/chat.ts";
import { DEFAULT_TZ, addDays, atLocalTime, formatDate, localDate } from "../src/clock.ts";
import { config, missingKeys } from "../src/config.ts";
import { clearMemory } from "../src/db.ts";
import { importHistory } from "../src/import.ts";
import { type Days, SCENARIOS } from "./scenarios.ts";

// npm run eval            run every scenario
// npm run eval -- stale   run scenarios whose name contains "stale"
//
// Each scenario runs the real agent against live search and is scored three ways: the number
// of searches it took, regex checks on the reply, and a judge model applying a written rubric.

if (missingKeys().length > 0) {
  console.error(`Missing ${missingKeys().join(" and ")}. Fill in .env first.`);
  process.exit(1);
}

// The judge stays fixed while the agent's model is varied, so runs are comparable.
const JUDGE_MODEL = "claude-sonnet-5-5";
const tz = DEFAULT_TZ;
const today = localDate(new Date(), tz);
const days: Days = {
  weekday: (daysAgo) => formatDate(addDays(today, -daysAgo)).split(" ")[0]!,
  dayMonth: (daysAgo) => formatDate(addDays(today, -daysAgo)).split(" ").slice(1, 3).join(" "),
};

async function judge(question: string, context: string, reply: string, rubric: string): Promise<{ pass: boolean; reason: string }> {
  const message = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 2000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { reason: { type: "string" }, pass: { type: "boolean" } },
          required: ["reason", "pass"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content:
          `You are grading one reply from a chat assistant that has web search and a memory of past conversations.\n\n` +
          `<what_the_assistant_was_given>\n${context}\n</what_the_assistant_was_given>\n\n<user_message>\n${question}\n</user_message>\n\n` +
          `<reply>\n${reply}\n</reply>\n\n<rubric>\n${rubric}\n</rubric>\n\n` +
          `Decide whether the reply satisfies every requirement in the rubric. Give the reason in one or two sentences, then pass or fail.`,
      },
    ],
  });
  const text = message.content.find((block) => block.type === "text")?.text ?? "";
  return JSON.parse(text) as { pass: boolean; reason: string };
}

// Comma-separated name fragments, e.g. `npm run eval -- stale,wrong day`.
const filters = process.argv[2]?.toLowerCase().split(",");
const rows: Record<string, string | number>[] = [];
let failures = 0;

for (const scenario of SCENARIOS) {
  if (filters && !filters.some((f) => scenario.name.toLowerCase().includes(f))) continue;
  clearMemory();
  if (scenario.history.length > 0) {
    importHistory({
      tz,
      conversations: scenario.history.map((h, i) => ({
        messages: [
          // Spread the planted questions through the morning so same-day ones keep their order.
          { role: "user", content: h.question, at: atLocalTime(addDays(today, -h.daysAgo), `1${i}:30`, tz).toISOString() },
          { role: "assistant", content: h.answer },
        ],
      })),
    });
  }

  const question = scenario.ask(days);
  const problems: string[] = [];
  let firstTextMs: number | null = null;
  let ms = 0;
  let searches = 0;
  try {
    // chatTurn logs a "[turn N] ..." line showing where the time went.
    const result = await chatTurn(`eval-${rows.length}`, question, tz, (event) => {
      if (event.type === "done") ({ firstTextMs, ms } = event);
    });
    await result.remembered;
    searches = result.searches;

    const [min, max] = scenario.searches;
    if (searches < min || searches > max) problems.push(`searches: ${searches}, expected ${min}-${max}`);
    for (const pattern of scenario.must ?? []) if (!pattern.test(result.answer)) problems.push(`missing ${pattern}`);
    for (const pattern of scenario.mustNot ?? []) if (pattern.test(result.answer)) problems.push(`contains ${pattern}`);
    const verdict = await judge(question, result.context, result.answer, scenario.rubric);
    if (!verdict.pass) problems.push(`judge: ${verdict.reason}`);

    console.log(`\n${"=".repeat(100)}\n${problems.length === 0 ? "PASS" : "FAIL"}  ${scenario.name}\n> ${question}\n\n${result.answer}\n`);
  } catch (error) {
    problems.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const problem of problems) console.log(`  x ${problem}`);
  if (problems.length > 0) failures++;
  rows.push({
    scenario: scenario.name,
    result: problems.length === 0 ? "pass" : "FAIL",
    searches,
    "first words (s)": firstTextMs === null ? "-" : (firstTextMs / 1000).toFixed(1),
    "total (s)": (ms / 1000).toFixed(1),
  });
}

console.log(`\nModel: ${config.agentModel}, effort ${config.agentEffort}`);
console.table(rows);
process.exit(failures === 0 ? 0 : 1);
