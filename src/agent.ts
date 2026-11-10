import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import type { Source, Turn } from "./db.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { type SearchHit, type SearchInput, WEB_SEARCH_TOOL, parseSearchInput, webSearch } from "./search.ts";

// One model, one loop. Each step the model either answers or asks for searches; all searches
// asked for in a step run in parallel. There is no planner, router or separate writer: every
// extra model call in front of the answer is latency the user feels, and the single loop
// already decides "search or not" as part of producing its first tokens.
//
// Search results go back to the model as text inside the user's message, not as tool_result
// blocks. Measured on Claude Sonnet 5.5: text that follows a tool_result is held back and
// delivered in one burst when the reply is complete, so after a search the user watched
// nothing for the whole of the writing time (about 7 s) and then got the full answer at once.
// The same results placed in the user message stream from the first token (about 1 s). The
// model can still call web_search again; the next step simply carries both rounds of results.

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

/** One search the model asked for, and what came back. */
interface Searched {
  /** The call as the model wrote it, for the "already run" list. */
  call: string;
  outcome: SearchHit[] | Error;
}

/** Prior turns of the conversation, replayed exactly as they were first sent. */
export function buildHistory(turns: Turn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of turns) {
    if (turn.answer === null) continue;
    const sources = turn.sources.length > 0 ? `\n\n<sources>\n${turn.sources.map((s) => `[${s.n}] ${s.title} ${s.url}`).join("\n")}\n</sources>` : "";
    messages.push({ role: "user", content: [{ type: "text", text: `${turn.context}\n\n${turn.question}` }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: turn.answer + sources }] });
  }
  // Everything up to here is identical on every step of this turn and is the prefix of the
  // next turn's request, so it is the right place for the prompt-cache breakpoint.
  const last = messages.at(-1);
  if (last && typeof last.content !== "string") {
    const tail = last.content.at(-1);
    if (tail?.type === "text") tail.cache_control = { type: "ephemeral" };
  }
  return messages;
}

export async function runAgent(
  history: Anthropic.MessageParam[],
  context: string,
  question: string,
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<AgentResult> {
  // url -> numbered source. Numbers are stable for the whole turn, so the same page found by
  // two searches is one citation.
  const registry = new Map<string, Source>();
  const searched: Searched[] = [];
  const usage = { input: 0, cachedInput: 0, output: 0 };

  for (let step = 1; ; step++) {
    // The context block (time + recalled memory) is identical on every step of the turn, so it
    // gets its own prompt-cache breakpoint: the step after a search reads it from cache and
    // only the search results and the question are new input.
    const content: Anthropic.TextBlockParam[] = [{ type: "text", text: context, cache_control: { type: "ephemeral" } }];
    if (searched.length > 0) content.push({ type: "text", text: renderResults(searched, registry) });
    content.push({ type: "text", text: question });
    const stream = anthropic.messages.stream(
      {
        model: config.agentModel,
        max_tokens: 8000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [WEB_SEARCH_TOOL],
        // On the last allowed step the model must answer with what it has.
        tool_choice: step < config.maxSteps ? { type: "auto" } : { type: "none" },
        output_config: { effort: config.agentEffort },
        // Thinking is left at the model's default (adaptive). Its lowest setting was measured:
        // it starts writing sooner after a search, but twice in five runs it answered around a
        // missing fact instead of searching once more. Being right won.
        messages: [...history, { role: "user", content }],
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
      const searches = searched.filter((s) => !(s.outcome instanceof Error)).length;
      return { answer, sources, searches, steps: step, usage };
    }

    emit({ type: "note" });

    // The model writes the tool input, so a malformed call is possible. It is reported back
    // like a failed search and the turn carries on.
    const inputs = calls.map((call): SearchInput | Error => {
      try {
        return parseSearchInput(call.input);
      } catch (error) {
        return error as Error;
      }
    });
    const valid = inputs.filter((input): input is SearchInput => !(input instanceof Error));
    emit({ type: "searching", searches: valid.map(({ query, domains }) => ({ query, domains })) });

    const outcomes = await Promise.all(
      inputs.map((input) => (input instanceof Error ? input : webSearch(input, signal).catch((error: Error) => error))),
    );
    signal?.throwIfAborted();

    const firstNew = registry.size + 1;
    calls.forEach((call, i) => {
      const outcome = outcomes[i]!;
      // Numbers are assigned here, in arrival order, before the results are rendered.
      if (!(outcome instanceof Error)) {
        for (const hit of outcome) {
          if (!registry.has(hit.url)) registry.set(hit.url, { n: registry.size + 1, url: hit.url, title: hit.title });
        }
      }
      searched.push({ call: JSON.stringify(call.input), outcome });
    });
    emit({ type: "sources", sources: [...registry.values()].filter((s) => s.n >= firstNew) });
  }
}

/** The block that carries every search run so far this turn back to the model. */
function renderResults(searched: Searched[], registry: Map<string, Source>): string {
  const shown = new Set<number>();
  const sections = searched.map(({ call, outcome }) => {
    const heading = `Search ${call}`;
    if (outcome instanceof Error) return `${heading}\nFailed: ${outcome.message}`;
    if (outcome.length === 0) return `${heading}\nNo results.`;
    const hits = outcome.map((hit) => {
      const n = registry.get(hit.url)!.n;
      // A page returned by two searches is printed once.
      if (shown.has(n)) return `[${n}] ${hit.title} (shown above)`;
      shown.add(n);
      const published = hit.published ? `\nPublished: ${hit.published}` : "";
      return `[${n}] ${hit.title}\nURL: ${hit.url}${published}\n${hit.content}`;
    });
    return `${heading}\n\n${hits.join("\n\n")}`;
  });
  return `<search_results>\n${sections.join("\n\n---\n\n")}\n</search_results>`;
}
