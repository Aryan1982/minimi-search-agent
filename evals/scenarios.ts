// Each scenario plants a history, asks one question "now", and states what a good reply does.
// The histories are written by hand so that the right answer is known in advance: a planted
// price that is certainly wrong today must be reported as changed, an empty memory must be
// admitted, and so on. Searches are live.

export interface Scenario {
  name: string;
  /** Exchanges already in memory, placed `daysAgo` days before the question. */
  history: { daysAgo: number; question: string; answer: string }[];
  /** The question, built from helpers that name past days the way a user would. */
  ask: (day: Days) => string;
  /** Inclusive bounds on how many searches the reply should take. */
  searches: [min: number, max: number];
  /** Checked on the reply text by code. */
  must?: RegExp[];
  mustNot?: RegExp[];
  /** Checked by a judge model that sees the question, the memory given, and the reply. */
  rubric: string;
}

export interface Days {
  /** "Tuesday" for the day `daysAgo` days back. */
  weekday(daysAgo: number): string;
  /** "3 November" for the day `daysAgo` days back. */
  dayMonth(daysAgo: number): string;
}

const POSTGRES_THEN =
  "Cheapest paid plans: **Supabase Pro** is $49/month per project and includes 8 GB of database space. " +
  "**Neon Launch** has no monthly minimum and bills usage. **Render Postgres** Basic starts at $6/month for 256 MB RAM.";

const CRM_THEN =
  "For a 20-person sales team I'd shortlist: 1. HubSpot Sales Hub, 2. Pipedrive, 3. Close, 4. Attio, 5. Zoho CRM. " +
  "Pipedrive is the easiest to adopt; HubSpot has the widest ecosystem.";

export const SCENARIOS: Scenario[] = [
  {
    name: "no memory: admits it, invents nothing",
    history: [],
    ask: () => "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    searches: [0, 0],
    rubric:
      "The reply must say plainly that it has no record of that conversation or shortlist. It must NOT name specific CRM tools as being the ones the user shortlisted. It should offer a way forward, such as asking for the five tools.",
  },
  {
    name: "recall only: lists everything asked that day, no search",
    history: [
      { daysAgo: 7, question: "Which managed Postgres hosting is cheapest for a small SaaS?", answer: POSTGRES_THEN },
      { daysAgo: 7, question: "Give me three name ideas for a bakery in Lisbon.", answer: "Forno Azul, Pão & Sal, Massa Mãe." },
      { daysAgo: 5, question: "How do I center a div?", answer: "Use flexbox: display:flex; justify-content:center; align-items:center." },
    ],
    ask: (day) => `What did I ask you on ${day.dayMonth(7)}?`,
    searches: [0, 0],
    must: [/postgres/i, /bakery/i],
    mustNot: [/center a div/i],
    rubric: "The reply must list both questions from that day (Postgres hosting and bakery names) and must not include the question from the other day.",
  },
  {
    name: "re-verify: catches a planted stale price",
    history: [{ daysAgo: 7, question: "Which managed Postgres hosting is cheapest for a small SaaS?", answer: POSTGRES_THEN }],
    ask: (day) => `Last ${day.weekday(7)} I asked you about Postgres hosting. Has any pricing changed since then?`,
    searches: [2, 10],
    must: [/\[\d+\]/, /\$49/],
    rubric:
      "The earlier answer said Supabase Pro is $49/month, which is wrong today. The reply must (a) say which date the earlier answer was from, (b) report that Supabase Pro's current price differs from the $49/month it gave before and state the current price with a citation, and (c) give a per-provider then-versus-now account rather than a fresh comparison that ignores the earlier answer.",
  },
  {
    name: "wrong day: says so, then uses the nearby exchange",
    history: [{ daysAgo: 4, question: "Shortlist 5 CRM tools for a 20-person sales team", answer: CRM_THEN }],
    // Ask about a day on which nothing was stored.
    ask: (day) => `On ${day.weekday(2)} we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?`,
    searches: [3, 12],
    must: [/hubspot/i, /pipedrive/i, /attio/i],
    rubric:
      "Memory holds the shortlist on a different day than the one the user named. The reply must point out the actual date of the shortlist (not silently accept the user's day), then proceed to check current pricing for the five shortlisted tools: HubSpot, Pipedrive, Close, Attio, Zoho. Since the earlier answer contained no prices, it must not claim prices are 'unchanged'; it should say there were no earlier prices to compare and give current ones.",
  },
  {
    name: "still correct?: re-checks a stale fact instead of trusting memory",
    history: [
      {
        daysAgo: 6,
        question: "What is the latest version of Python?",
        answer: "The latest stable release of Python is 3.9.2.",
      },
    ],
    ask: (day) => `What did I ask you on ${day.dayMonth(6)}? Is your answer still correct today?`,
    searches: [1, 5],
    must: [/3\.9\.2/, /\[\d+\]/],
    rubric: "The reply must restate that the user asked about the latest Python version and that the earlier answer was 3.9.2, then say that this is no longer correct and give the current latest stable version with a citation.",
  },
  {
    name: "plain reasoning: answers directly, no search, no memory talk",
    history: [{ daysAgo: 3, question: "Shortlist 5 CRM tools for a 20-person sales team", answer: CRM_THEN }],
    ask: () => "What's 17% of 2,340?",
    searches: [0, 0],
    must: [/397\.8/],
    mustNot: [/CRM|record|memory/i],
    rubric: "The reply gives 397.8 briefly, without mentioning past conversations.",
  },
  {
    name: "fresh fact: searches and cites",
    history: [],
    ask: () => "What's the newest iPhone model and what does it cost in the US?",
    searches: [1, 5],
    must: [/\[\d+\]/, /\$\d/],
    rubric: "The reply names a specific current iPhone model and a US price, each supported by a citation, and leads with the answer.",
  },
  {
    name: "world question with a date: not mistaken for a memory question",
    history: [{ daysAgo: 7, question: "Give me three name ideas for a bakery in Lisbon.", answer: "Forno Azul, Pão & Sal, Massa Mãe." }],
    ask: (day) => `What were the biggest tech news stories last ${day.weekday(7)}?`,
    searches: [1, 6],
    mustNot: [/bakery/i, /no record/i],
    rubric: "The reply reports tech news from the named day with citations. It must not talk about the user's past conversations or say it has no record.",
  },
];
