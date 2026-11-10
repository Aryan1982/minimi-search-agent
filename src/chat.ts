import { type AgentEvent, type AgentResult, buildHistory, runAgent } from "./agent.ts";
import { formatDateTime, localDate, now } from "./clock.ts";
import { config } from "./config.ts";
import { completeTurn, conversationTurns, insertTurn, upsertConversation } from "./db.ts";
import { extractMemory } from "./extract.ts";
import { recall, recheckSearches, renderContext } from "./memory.ts";

// One user turn, start to finish:
//   1. recall   - code only: resolve dates, look up past exchanges, render the context block
//   2. answer   - the agent loop, streaming
//   3. remember - store the exchange now; extract its claims in the background

export type ChatEvent =
  | AgentEvent
  /** What memory put in front of the model, for the interface to show. */
  | {
      type: "recall";
      dates: { text: string; label: string; found: boolean }[];
      exchanges: { date: string; question: string }[];
    }
  | { type: "done"; turnId: number; answer: string; sources: AgentResult["sources"]; ms: number; firstTextMs: number | null; searches: number };

export interface ChatTurnResult extends AgentResult {
  turnId: number;
  /** The context block the model was given. */
  context: string;
  /** Settles when background extraction has finished; never rejects. */
  remembered: Promise<void>;
}

export async function chatTurn(
  conversationId: string,
  question: string,
  tz: string,
  emit: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<ChatTurnResult> {
  const started = performance.now();
  const at = now();

  const history = conversationTurns(conversationId)
    .filter((t) => t.answer !== null)
    .slice(-config.historyTurns);
  const recalled = recall(question, at, tz, new Set(history.map((t) => t.id)));
  const context = renderContext(recalled, at, tz);

  upsertConversation(conversationId, question.replace(/\s+/g, " ").slice(0, 80), at.getTime());
  const turnId = insertTurn({ conversationId, at: at.getTime(), localDate: localDate(at, tz), tz, question, context });

  if (recalled.dates.length > 0 || recalled.exchanges.length > 0) {
    emit({
      type: "recall",
      dates: recalled.dates.map((d) => ({ text: d.text, label: d.window.label, found: d.found })),
      exchanges: recalled.exchanges.map((t) => ({ date: formatDateTime(new Date(t.at), t.tz), question: t.question })),
    });
  }

  // Where the time went, in seconds from the start: "3.1 search x4 | 5.8 results | 6.9 text".
  const timeline: string[] = [];
  let firstTextMs: number | null = null;
  let writing = false;
  const result = await runAgent(
    buildHistory(history),
    context,
    question,
    (event) => {
      const elapsed = performance.now() - started;
      if (event.type === "text" && !writing) timeline.push(`${(elapsed / 1000).toFixed(1)} text`);
      writing = event.type === "text";
      if (event.type === "text") firstTextMs ??= Math.round(elapsed);
      // Text before a search was a remark, not the answer; time-to-first-text restarts.
      if (event.type === "note") firstTextMs = null;
      if (event.type === "searching") timeline.push(`${(elapsed / 1000).toFixed(1)} search x${event.searches.length}`);
      if (event.type === "sources") timeline.push(`${(elapsed / 1000).toFixed(1)} results`);
      emit(event);
    },
    signal,
    recheckSearches(question, recalled, at),
  );

  completeTurn(turnId, result.answer, result.sources);
  const ms = Math.round(performance.now() - started);
  timeline.push(`${(ms / 1000).toFixed(1)} done`);
  console.log(`[turn ${turnId}] ${timeline.join(" | ")}  (${result.usage.input}+${result.usage.cachedInput} cached in, ${result.usage.output} out)`);
  emit({ type: "done", turnId, answer: result.answer, sources: result.sources, ms, firstTextMs, searches: result.searches });

  const remembered = extractMemory(turnId).catch((error: Error) => {
    console.error(`[memory] extraction failed for turn ${turnId}: ${error.message}`);
  });
  return { ...result, turnId, context, remembered };
}
