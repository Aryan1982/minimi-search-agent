# Design

## How it works

A user turn has three stages. Only the middle one calls a model before the reply.

```
1. RECALL (code, ~1 ms)            2. ANSWER (one model loop)          3. REMEMBER (background)
   "last Tuesday" → 3 Nov             Claude Sonnet, streaming            store Q + A + sources at once;
   SQLite: by date, then topic        one tool: web_search (Tavily)       Claude Haiku lists each checkable
   → context block before the msg     parallel calls, numbered cites      claim with its source URL
```

1. **Recall.** Date phrases are resolved in code to calendar dates in the user's timezone. Matching past exchanges are fetched from SQLite (date window first, then full-text rank) and placed in front of the message, verbatim, with their dates and sources. If nothing is stored for that date, the block says so and offers the nearest exchange on the topic.
2. **Answer.** The model either answers or asks for searches. All searches in a step run in parallel. Results are numbered once per turn and cited as `[3]`.
3. **Remember.** The exchange is stored when the answer completes. Afterwards a small model extracts the claims that could change (entity, attribute, value, source); next time they are the re-check list.

## Why I built it this way

- **The test questions are "last Tuesday I asked X; has it changed?"** So the core is dated memory plus re-verification, and on a fresh install, an honest "I have no record of that".
- **Memory is not a tool.** The agent has one tool. Recall runs in code before the model, which also saves a model round trip.
- **Dates are resolved in code because a wrong date fails silently.** The resolver is deterministic and unit-tested, always resolves into the past, and keeps both readings of an ambiguous phrase, preferring the day that holds a conversation on the topic. The reply names the date.
- **A past answer is evidence, not truth.** The prompt asks for one search per entity against the vendor's own page and three distinct outcomes: changed, checked and unchanged, could not verify.
- **Search results go back as text in the user message, not as `tool_result` blocks.** Measured: Sonnet 5.5 holds back all text that follows a tool result and delivers it in one burst, so nothing streamed after a search. As text it streams from the first token; time to first words after a search fell from 9–15 s to 4–13 s.
- **Search depth by purpose.** Tavily "fast" (1.2 s against 2.4 s) for open queries. Pinned to a vendor's site it returned no plan prices, so those use "basic".
- **Prompt caching** on the system prompt, the history, and the recalled-memory block.
- **An injectable clock,** so the seed script and evals can put a real conversation in the past.

Eight scripted scenarios against live search all pass (`npm run eval`). Without a search, first words arrive in about 1 s; with one, in 4–13 s, finishing in 7–17 s.

## What I considered and rejected

- **Sonnet plans, Haiku writes.** Haiku took extra search rounds and was slower overall; Haiku alone twice failed to correct a wrong day.
- **The advisor tool (Haiku consulting Sonnet).** It is a second tool, and in three test scenarios Haiku never called it.
- **Thinking at its lowest setting.** Faster to first word, but twice in five runs it answered around a missing fact instead of searching again.
- **Embeddings.** These questions are indexed by date first; a date range plus BM25 is exact at this scale and needs no third key.
- **Provider-native search.** It hides results, so sources could not be numbered, stored and re-checked.
- **An LLM router for "is this about memory".** Latency on every turn; a cue pattern plus date detection covers it.
- **An agent framework.** The loop is small, and owning it is what made the streaming fix possible.

## What I'd do with another week

1. **Start the re-check in code.** When recall finds claims with source URLs, launch those searches before the model's first step, removing the 2–3 s planning step.
2. **Keep the evidence.** Store the cited passage with each claim, to show old and new text side by side.
3. **Recorded evals.** Replay saved search results so the suite is free, repeatable and larger; add injected-instruction and contradictory-source cases.
4. **Watches.** "Tell me when any of these change price" is the same claim list on a schedule.
