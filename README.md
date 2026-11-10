# minimi-search-agent

A chat agent with one tool, web search, and a dated memory of everything you have asked it. Ask a question today; next week ask *"has any of that changed since?"* and it re-checks its own earlier answer against the live web.

Built for the minimi hiring challenge. The reasoning is in [DESIGN.md](DESIGN.md).

## Run it

Requires Node 22.13 or newer.

```bash
npm install
cp .env.example .env    # then fill in the two keys
npm run dev             # http://localhost:3000
```

| Key | Used for | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | The model (Claude Sonnet for answers, Claude Haiku for background memory extraction) | https://platform.claude.com/ |
| `TAVILY_API_KEY` | Web search (the free plan is enough) | https://app.tavily.com/ |

## Try the memory without waiting a week

A fresh install has no past, so *"On Monday we shortlisted 5 CRM tools…"* gets an honest *"I have no record of that"*. To give it a past:

```bash
npm run seed
```

This moves the clock back, asks the real agent three real questions (Postgres hosting a week ago, a CRM shortlist last Monday, the Node.js LTS three days ago), and stores its genuine answers under those dates. It prints the follow-up questions to try. It uses about a dozen searches.

To load your own dated conversations instead:

```bash
npm run import -- history.json
```

```json
{
  "tz": "Asia/Kolkata",
  "conversations": [
    { "messages": [
      { "role": "user", "content": "Which Postgres host is cheapest?", "at": "2026-11-03T10:00:00+05:30" },
      { "role": "assistant", "content": "Supabase Pro is $25/month ..." }
    ] }
  ]
}
```

The same JSON can be sent to `POST /api/import` while the app is running.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app with reload on change |
| `npm test` | Unit tests for date resolution and memory recall (no keys, no network) |
| `npm run eval` | Run the real agent through scripted scenarios against live search and grade the replies |
| `npm run seed` | Create a genuine, back-dated history to ask about |
| `npm run import -- file.json` | Load dated conversations into memory |
| `npm run typecheck` | TypeScript check |

## Layout

```
src/
  server.ts    HTTP + server-sent events
  chat.ts      one user turn: recall -> answer -> remember
  dates.ts     "last Tuesday" -> a calendar date, in code
  memory.ts    find past exchanges by date and topic; render the context block
  agent.ts     the model loop: stream, run searches in parallel, number sources
  search.ts    the web_search tool (Tavily)
  extract.ts   background: list the checkable claims in an answer
  prompt.ts    the system prompt
  db.ts        SQLite (node:sqlite): turns, full-text index, claims
  clock.ts     the injectable clock and timezone helpers
  import.ts    load dated history
public/        the chat interface (no build step)
evals/         scenarios and the runner
test/          unit tests
```

Data lives in `data/agent.db`. Delete the file to forget everything.
