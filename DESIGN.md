# Design

## What the task is really asking

The sample questions are all the same shape: *"Last Tuesday I asked you about X. Has anything changed since?"* Answering that takes three things a plain search chatbot does not have: a memory of past exchanges **with dates**, the ability to turn "last Tuesday" into the right calendar day, and the habit of treating its own earlier answer as a claim to re-check rather than a fact. It also takes the honesty to say "I have no record of that" on a fresh install, instead of inventing a shortlist. The design is built around those four points.

## How it works

One user turn has three stages. Only the middle one calls a model.

```
message ─▶ 1. RECALL (code, ~1 ms)          ─▶ 2. ANSWER (one model loop)      ─▶ 3. REMEMBER
           dates.ts: "last Tuesday" → 3 Nov      agent.ts: Sonnet, streaming        db: store Q + A + sources now
           memory.ts: SQLite lookup by           one tool: web_search (Tavily)      extract.ts: Haiku lists the
           date window, then by topic            parallel calls, numbered cites     checkable claims, in background
           → <context> block before the message
```

**1. Recall is code, not a tool.** The brief says the agent has one tool, web search, so memory is not a second tool. Before the model is called, `dates.ts` resolves date phrases to civil-date windows in the user's timezone, and `memory.ts` fetches the exchanges in that window (ranked by topic with SQLite full-text search) and renders them, verbatim with their sources and dates, into a `<context>` block placed in front of the user's message. If nothing is stored for that date, the block says so and offers the nearest exchange on the same topic. The model starts its first token already holding the past exchange, or the fact that there is none.

**2. One model, one loop.** Claude Sonnet reads the message and either answers or asks for searches. All searches requested in a step run in parallel (five CRMs are five concurrent searches, one round). Results are numbered once per turn; the model cites `[3]` and the interface turns that into a link. A hard cap of six steps forces an answer. Text streams from the first token.

**3. Remembering never blocks the reply.** The exchange is stored and indexed the moment the answer completes. Then Claude Haiku, in the background, extracts a one-line summary, the entities, and each fact that could change (entity, attribute, value, source URL). Next time, recall hands the model that list as a re-check checklist next to the verbatim answer.

## Why this way

- **Dates are resolved by code because a wrong date fails silently.** A model doing calendar arithmetic is right most of the time; when it is wrong it recalls the wrong conversation and nobody notices. `dates.ts` is deterministic and unit-tested, resolves everything into the past (a bare "Friday" is last Friday), and keeps both readings of an ambiguous phrase ("last Tuesday" said on a Thursday), choosing the one whose day holds a conversation on the topic. The reply states the resolved date so a misreading is visible.
- **Fast comes from removing model calls, not from a smaller model.** There is no router, planner, query rewriter or separate writer in front of the answer. Recall costs a millisecond. The system prompt is byte-identical on every request and everything variable travels in the user message, so the prompt prefix is cached across steps and turns.
- **Right comes from the past answer being evidence, not truth.** The prompt frames a recalled answer as "claims that were true on that date", asks for one search per entity against the primary source, and requires three distinct outcomes: changed, checked and unchanged, could not verify.
- **Memory is one table.** A turn (question, answer, sources, timestamp, civil date, timezone) is both the chat history and the memory unit, so there is nothing to keep in sync. Extraction is an enhancement on top: if it fails, recall still works from the stored answer.
- **The clock is injectable.** `npm run seed` and the evals move "now" into the past, ask real questions, then come back to today. That is how "last Tuesday" was tested without waiting a week.

## Considered and rejected

- **Memory as a second tool.** Breaks the one-tool rule, costs an extra model round trip on exactly the questions being tested, and lets the model skip the lookup and guess.
- **A split of "one model thinks, a cheaper one writes".** Two calls in sequence is slower than one, and the final wording of a then-versus-now comparison is where precision matters most. The cheap model is used where latency is free: background extraction.
- **Embeddings / a vector store.** These questions are indexed by date first; similarity search is weak at "on 3 November". At one user's scale, a date range plus BM25 is exact, instant, and needs no third API key.
- **Provider-native web search.** It hides queries and results from the harness, so sources could not be numbered, stored with the answer, or re-checked later.
- **An LLM classifier to decide "is this a memory question".** A few hundred milliseconds on every turn. A regex cue plus date detection covers it, and a miss degrades gently: related history still appears as one-line mentions.
- **LangChain or an agent framework.** The loop is about a hundred lines; owning it is what allows parallel tool execution, stable citation numbers and prompt-cache control.
- **Stuffing all history into every prompt.** Works for a week, then gets slow, expensive, and buries the one relevant exchange.

## With another week

1. **Speculative re-verification.** When recall finds claims to re-check, start the searches in code while the model is still reading, and hand them over as already-run tool results.
2. **Snapshot the evidence.** Store the cited passage with each claim, so "changed" can show the old and new text side by side, and so a vanished page is detectable.
3. **A bigger, recorded eval set.** Replay recorded search results so the suite is free and deterministic, add multi-turn and adversarial cases (prompt injection inside a search result, contradictory sources), and sweep model and effort settings on it.
4. **Standing watches.** "Tell me when any of these change price" is the same claim ledger re-checked on a schedule.
