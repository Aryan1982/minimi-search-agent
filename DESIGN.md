# Design

## How it works

Each user turn has three stages. Only the middle one calls a model before the reply.

```
1. RECALL (code, ~1 ms)          2. ANSWER (one model loop)         3. REMEMBER (background)
   "last Tuesday" → 3 Nov           Claude Sonnet, streaming           store Q + A + sources at once;
   SQLite: by date, then topic      one tool: web_search (Tavily)      Claude Haiku writes the claims
   → context before the message     parallel calls, [n] citations      and the searches to re-check them
```

1. **Recall.** Date phrases are resolved in code to calendar dates in the user's timezone. Matching past exchanges are fetched by date, ranked by topic, and placed in front of the message with their dates and sources. If nothing is stored for that date, the context says so and offers the nearest exchange on the topic.
2. **Answer.** The model answers or asks for searches; all searches in a step run in parallel. Sources are numbered once per turn.
3. **Remember.** The exchange is stored when the answer completes. A small model then lists the claims that could change and the searches that would verify them.

When a later message asks whether a remembered answer still holds, those stored searches run immediately, before the model is called.

## Why I built it this way

- **The test questions are "last Tuesday I asked X; has it changed?"** So the core is dated memory plus re-verification, and an honest "I have no record of that" on a fresh install.
- **Memory is not a tool.** The brief allows one tool. Recall runs in code, which also saves a model round trip.
- **Dates are resolved in code because a wrong date fails silently.** The resolver is unit-tested, always resolves into the past, and keeps both readings of an ambiguous phrase. The reply names the date.
- **A past answer is evidence, not truth.** Every re-check ends as changed, checked and unchanged, or could not verify.
- **Search results return as text in the user message, not `tool_result` blocks.** Measured: Sonnet 5.5 held back everything after a tool result and sent it in one burst. As text, the answer streams.
- **Re-check searches are planned when the answer is stored,** where latency is free. This removed the model's planning step: first words on a re-check went from about 12 s to 4–8 s.

Eight scripted scenarios against live search passed in three consecutive runs (`npm run eval`). Without a search, first words arrive in about 1 s; with one, in 4–9 s.

## What I considered and rejected

- **Sonnet plans, Haiku writes.** Slower overall; Haiku alone twice failed to correct a wrong day.
- **The advisor tool.** A second tool, and Haiku never called it in testing.
- **Thinking off everywhere.** Faster, but in two of five runs it answered around a missing fact instead of searching again. It is off only on the pre-searched step.
- **Embeddings.** These questions are indexed by date first.
- **SQLite full-text search.** Node 22.13's SQLite lacks it; ranking is forty lines of code.
- **Provider-native search.** It hides results, so sources could not be stored and re-checked.
- **An agent framework.** Owning the loop made the streaming fix possible.

## What I'd do with another week

1. **Read full pages for re-checks.** Snippets sometimes miss the price, giving "could not verify".
2. **Keep the evidence.** Store the cited passage with each claim, to show old and new side by side.
3. **Recorded evals.** Replay saved search results so the suite is free, repeatable and larger.
4. **Watches.** "Tell me when any of these change price" is the stored re-check list on a schedule.
