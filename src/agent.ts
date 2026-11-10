import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import type { Source, Turn } from "./db.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { type SearchHit, type SearchInput, WEB_SEARCH_TOOL, parseSearchInput, webSearch } from "./search.ts";

// One model, one loop. Each step the model either answers or asks for searches; all searches
// asked for in a step run in parallel. There is no planner, router or separate writer: every
// extra model call in front of the answer is latency the user feels, and the single loop
// already decides "search or not" as part of producing its first tokens.

export const anthropic = new Anthropic({ apiKey: config.anthropicKey });

export type AgentEvent =
  /** A piece of the reply, as it is written. */
  | { type: "text"; text: string }
  /** The text streamed so far in this step turned out to precede a search, not to be the answer. */
  | { type: "note" }
  | { type: "searching"; searches: { query: string; domains: string[] }[] }
  /** Pages found by the searches just run, with the numbers the model will cite them by. */
  | { type: "sources"; sources: Source[] };

export interface AgentResult {
  answer: string;
  /** Only the sources the answer cites. */
  sources: Source[];
  searches: number;
  steps: number;
  usage: { input: number; cachedInput: number; output: number };
}

/** The conversation as the model sees it: prior turns replayed exactly, then the new message. */
export function buildMessages(history: Turn[], context: string, question: string): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of history) {
    if (turn.answer === null) continue;
    const sources = turn.sources.length > 0 ? `\n\n<sources>\n${turn.sources.map((s) => `[${s.n}] ${s.title} ${s.url}`).join("\n")}\n</sources>` : "";
    messages.push({ role: "user", content: [{ type: "text", text: `${turn.context}\n\n${turn.question}` }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: turn.answer + sources }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: `${context}\n\n${question}` }] });
  return messages;
}

export async function runAgent(
  messages: Anthropic.MessageParam[],
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<AgentResult> {
  // url -> numbered source. Numbers are stable for the whole turn, so the same page found by
  // two searches is one citation.
  const registry = new Map<string, Source>();
  const usage = { input: 0, cachedInput: 0, output: 0 };
  let searches = 0;

  for (let step = 1; ; step++) {
    const stream = anthropic.messages.stream(
      {
        model: config.agentModel,
        max_tokens: 8000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [WEB_SEARCH_TOOL],
        // On the last allowed step the model must answer with what it has. The tool stays
        // declared so the request prefix, and with it the prompt cache, is unchanged.
        tool_choice: step < config.maxSteps ? { type: "auto" } : { type: "none" },
        output_config: { effort: config.agentEffort },
        messages: withCacheBreakpoint(messages),
      },
      { signal },
    );
    stream.on("text", (text) => emit({ type: "text", text }));
    const message = await stream.finalMessage();

    usage.input += message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0);
    usage.cachedInput += message.usage.cache_read_input_tokens ?? 0;
    usage.output += message.usage.output_tokens;

    const calls = message.content.filter((block) => block.type === "tool_use");
    if (message.stop_reason !== "tool_use" || calls.length === 0) {
      let answer = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        // The model sees <sources> blocks on replayed turns and is told not to write one; drop it if it does.
        .replace(/\s*<sources>[\s\S]*$/, "")
        .trim();
      if (message.stop_reason === "max_tokens") answer += "\n\n*(The reply hit its length limit and was cut off.)*";
      if (!answer) throw new Error(`The model returned no answer (stop reason: ${message.stop_reason}).`);

      const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
      const sources = [...registry.values()].filter((s) => cited.has(s.n));
      return { answer, sources, searches, steps: step, usage };
    }

    // The assistant turn goes back exactly as returned, thinking blocks included.
    messages.push({ role: "assistant", content: message.content });
    emit({ type: "note" });

    const inputs = calls.map((call) => {
      try {
        return parseSearchInput(call.input);
      } catch (error) {
        return error as Error;
      }
    });
    const valid = inputs.filter((input): input is SearchInput => !(input instanceof Error));
    searches += valid.length;
    emit({ type: "searching", searches: valid.map(({ query, domains }) => ({ query, domains })) });

    // A failed search becomes an error result the model can read and route around; it does
    // not fail the turn.
    const outcomes = await Promise.all(
      inputs.map((input) => (input instanceof Error ? input : webSearch(input, signal).catch((error: Error) => error))),
    );
    signal?.throwIfAborted();

    const firstNew = registry.size + 1;
    const results: Anthropic.ToolResultBlockParam[] = calls.map((call, i) => {
      const outcome = outcomes[i]!;
      return outcome instanceof Error
        ? { type: "tool_result", tool_use_id: call.id, content: outcome.message, is_error: true }
        : { type: "tool_result", tool_use_id: call.id, content: formatHits(outcome, registry) };
    });
    emit({ type: "sources", sources: [...registry.values()].filter((s) => s.n >= firstNew) });
    messages.push({ role: "user", content: results });
  }
}

function formatHits(hits: SearchHit[], registry: Map<string, Source>): string {
  if (hits.length === 0) return "No results.";
  return hits
    .map((hit) => {
      let source = registry.get(hit.url);
      if (!source) {
        source = { n: registry.size + 1, url: hit.url, title: hit.title };
        registry.set(hit.url, source);
      }
      const published = hit.published ? `\nPublished: ${hit.published}` : "";
      return `[${source.n}] ${hit.title}\nURL: ${hit.url}${published}\n${hit.content}`;
    })
    .join("\n\n");
}

/**
 * Mark the end of the conversation as a cache breakpoint. Within a turn each step re-sends
 * everything before it, and across turns each request re-sends the history, so all but the
 * newest message is read from cache. Returns a copy; `messages` itself stays unmarked.
 */
function withCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages.at(-1);
  if (!last || last.role !== "user" || typeof last.content === "string") return messages;
  const tail = last.content.at(-1);
  if (!tail || (tail.type !== "text" && tail.type !== "tool_result")) return messages;
  const marked = { ...tail, cache_control: { type: "ephemeral" as const } };
  return [...messages.slice(0, -1), { role: "user", content: [...last.content.slice(0, -1), marked] }];
}
