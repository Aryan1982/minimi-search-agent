import { type AgentEvent, type AgentResult, buildMessages, runAgent } from "./agent.ts";
import { formatDateTime, localDate, now } from "./clock.ts";
import { config } from "./config.ts";
import { completeTurn, conversationTurns, insertTurn, upsertConversation } from "./db.ts";
import { extractMemory } from "./extract.ts";
import { recall, renderContext } from "./memory.ts";

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

  let firstTextMs: number | null = null;
  const result = await runAgent(
    buildMessages(history, context, question),
    (event) => {
      if (event.type === "text") firstTextMs ??= Math.round(performance.now() - started);
      // Text before a search was a remark, not the answer; time-to-first-text restarts.
      if (event.type === "note") firstTextMs = null;
      emit(event);
    },
    signal,
  );

  completeTurn(turnId, result.answer, result.sources);
  emit({
    type: "done",
    turnId,
    answer: result.answer,
    sources: result.sources,
    ms: Math.round(performance.now() - started),
    firstTextMs,
    searches: result.searches,
  });

  const remembered = extractMemory(turnId).catch((error: Error) => {
    console.error(`[memory] extraction failed for turn ${turnId}: ${error.message}`);
  });
  return { ...result, turnId, context, remembered };
}
