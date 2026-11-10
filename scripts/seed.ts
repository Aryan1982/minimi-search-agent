import { randomUUID } from "node:crypto";
import { chatTurn } from "../src/chat.ts";
import { DEFAULT_TZ, addDays, atLocalTime, formatDate, localDate, setNow } from "../src/clock.ts";
import { missingKeys } from "../src/config.ts";

// Gives a fresh install a past to ask about. It moves the clock back, asks the real agent real
// questions, and lets it answer from live search - so the stored answers, sources and claims
// are genuine, only their dates are in the past. Afterwards you can ask "has anything changed
// since?" without waiting a week.
//
// Costs about a dozen web searches. Run once: npm run seed

if (missingKeys().length > 0) {
  console.error(`Missing ${missingKeys().join(" and ")}. Fill in .env first.`);
  process.exit(1);
}

const today = localDate(new Date(), DEFAULT_TZ);
const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
// The most recent Monday before today.
const lastMonday = addDays(today, -((weekday + 6) % 7 || 7));

const PAST = [
  {
    date: addDays(today, -7),
    question: "I need managed Postgres hosting for a small SaaS. Compare Supabase, Neon, Render and Amazon RDS: what does the cheapest paid plan of each cost per month, and what do you get?",
  },
  {
    date: lastMonday,
    question: "Shortlist 5 CRM tools for a 20-person sales team, with the per-user monthly price of the plan you'd pick for each.",
  },
  {
    date: addDays(today, -3),
    question: "What is the current Node.js LTS version, and when does it stop getting security fixes?",
  },
].sort((a, b) => a.date.localeCompare(b.date));

for (const { date, question } of PAST) {
  setNow(atLocalTime(date, "10:30", DEFAULT_TZ));
  console.log(`\n${formatDate(date)}\n> ${question}`);
  const result = await chatTurn(randomUUID(), question, DEFAULT_TZ, () => {});
  await result.remembered;
  console.log(`${result.answer.slice(0, 300).replace(/\s+/g, " ")}...\n(${result.searches} searches, ${result.sources.length} sources cited)`);
}
setNow(null);

console.log(`
Done. Start the app with "npm run dev" and try:

  Last ${new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(`${addDays(today, -7)}T00:00:00Z`))} I asked you about Postgres hosting. Has any pricing changed since then?
  On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?
  What did I ask you on ${formatDate(addDays(today, -3)).split(" ").slice(1, 3).join(" ")}? Is your answer still correct today?
`);
