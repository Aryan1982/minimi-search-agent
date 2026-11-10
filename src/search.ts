import { now } from "./clock.ts";
import { config } from "./config.ts";
import { cacheSearch, cachedSearch } from "./db.ts";

// The agent's one tool. A single Tavily call returns ranked pages with the relevant passages
// already extracted, so there is no separate "open this URL" tool and no second round trip.

export interface SearchInput {
  query: string;
  /** Restrict results to these sites, e.g. the page a past answer cited. */
  domains: string[];
  /** Only pages published within this window. */
  recency: Recency | null;
}

export interface SearchHit {
  url: string;
  title: string;
  content: string;
  /** ISO date when Tavily could detect one. */
  published: string | null;
}

const RECENCY = ["day", "week", "month", "year"] as const;
type Recency = (typeof RECENCY)[number];

const CACHE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 15_000;

/** The definition the model sees. */
export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description:
    "Search the live web. Returns up to 5 pages, each with its URL, title, publish date when known, and the passages most " +
    "relevant to the query. Call it several times in one step to run searches in parallel: one focused query per entity or " +
    "question beats one broad query. Write queries the way you would type them into a search engine, and include the " +
    "current year when you need current facts such as prices.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "The search query." },
      domains: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional. Only return pages from these domains, e.g. ['supabase.com']. Use it to go to the primary source, or to " +
          "re-check the same page a past answer cited.",
      },
      recency: {
        type: "string",
        enum: [...RECENCY],
        description:
          "Optional. Only return pages published in the last day, week, month or year. Use it for news and announcements. " +
          "Leave it out for pricing and documentation pages, which keep old publish dates.",
      },
    },
    required: ["query"],
  },
};

/** The model writes the tool input, so treat it as untrusted and keep only what is well formed. */
export function parseSearchInput(raw: unknown): SearchInput {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) throw new Error("web_search needs a non-empty `query` string.");
  const domains = Array.isArray(input.domains)
    ? input.domains
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
        .filter(Boolean)
    : [];
  const recency = RECENCY.find((r) => r === input.recency) ?? null;
  return { query, domains, recency };
}

export async function webSearch(input: SearchInput, signal?: AbortSignal): Promise<SearchHit[]> {
  const key = JSON.stringify([input.query.toLowerCase(), [...input.domains].sort(), input.recency]);
  const nowMs = now().getTime();
  // A short cache: follow-up questions repeat searches, and the free Tavily plan is 1,000 a month.
  const cached = cachedSearch(key, CACHE_MS, nowMs);
  if (cached) return JSON.parse(cached) as SearchHit[];

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.tavilyKey}` },
    body: JSON.stringify({
      query: input.query,
      // Two depths at the same credit cost, chosen by measurement. Open queries use "fast"
      // (about 1.2 s against 2.4 s for "basic" on three pricing queries). A search pinned
      // to a vendor's own site is a re-check of a specific figure, and there "fast" returned
      // the wrong passages: on pipedrive.com and zoho.com pricing queries it surfaced no plan
      // prices at all, where "basic" surfaced all of them. Being right is worth the second.
      search_depth: input.domains.length > 0 ? "basic" : "fast",
      max_results: 5,
      chunks_per_source: 3,
      include_published_date: true,
      ...(input.domains.length > 0 && { include_domains: input.domains }),
      ...(input.recency && { time_range: input.recency }),
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    throw new Error(`Tavily search failed with HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const body = (await response.json()) as { results?: unknown };
  const hits: SearchHit[] = [];
  for (const r of Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : []) {
    if (typeof r.url !== "string" || typeof r.content !== "string") continue;
    hits.push({
      url: r.url,
      title: typeof r.title === "string" && r.title ? r.title : r.url,
      content: r.content,
      published: typeof r.published_date === "string" ? r.published_date : null,
    });
  }
  cacheSearch(key, JSON.stringify(hits), nowMs);
  return hits;
}
