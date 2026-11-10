import { formatDate, formatDateTime, localDate } from "./clock.ts";
import { type DateWindow, resolveDates } from "./dates.ts";
import { type Turn, claimsFor, memoryStats, recentTurns, turnsInRange, turnsMatching } from "./db.ts";

// Recall happens here, in the harness, before the model is called. The agent has one tool and
// it is web search; memory is not a second tool. That also removes a model round trip: by the
// time the model reads the question, the past exchange it refers to is already on the page.
//
// No model is involved in recall. Dates come from dates.ts, topics from a full-text index,
// so the same question always recalls the same thing and the whole path is unit-tested.

const FULL_EXCHANGES = 4;
const ONE_LINERS = 20;
const ANSWER_CHARS = 4000;
// Extraction lists claims most important first. A dozen is a checklist; thirty made the model
// audit every detail of the old answer, which was slow to think through and long to read.
const CLAIMS_SHOWN = 12;

export interface Recall {
  /** The user is talking about an earlier conversation with the agent. */
  refersToHistory: boolean;
  /** Date phrases found, with the window recall settled on for each. */
  dates: { text: string; window: DateWindow; found: boolean }[];
  /** Past exchanges shown to the model in full. */
  exchanges: Turn[];
  /** Past exchanges shown as one line each. */
  mentions: Turn[];
}

// Phrases that point at the shared past rather than at the world.
const REFERS_TO_HISTORY = new RegExp(
  [
    String.raw`\b(?:i|we)\s+(?:\w+\s+)?(?:asked|talked|spoke|discussed|chatted|shortlisted|listed|compared|picked|chose|decided|settled|looked|mentioned|said|told|went\s+with|narrowed)`,
    String.raw`\byou\s+(?:\w+\s+)?(?:said|told|answered|recommended|suggested|mentioned|gave|found|listed|claimed|wrote)`,
    String.raw`\bdid\s+(?:i|we|you)\s+(?:ask|say|talk|discuss|tell|recommend|suggest|decide|pick|choose|mention)`,
    String.raw`\b(?:your|that|the)\s+(?:previous\s+|earlier\s+|last\s+)?(?:answer|recommendation|response|shortlist|suggestion)`,
    String.raw`\b(?:our|my)\s+(?:previous\s+|earlier\s+|last\s+)?(?:conversation|chat|discussion|question|shortlist)`,
    String.raw`\b(?:last\s+time|previously|remember|recall|as\s+before)\b`,
  ].join("|"),
  "i",
);

// Words that say nothing about the topic. Besides common English, this drops the vocabulary of
// asking-about-the-past ("asked", "tuesday", "changed", "since") so that it cannot match.
const STOPWORDS = new Set(
  `the and for are but not you your yours all any can had has have her his him how its our out was were who why did does doing
  get got let may new now old see two way use used with what when where which while will would could should there their them then
  than that this these those they been being from into just like more most much many some such only over also very about after
  again before since still ever even here have ask asked asking tell told said say says talk talked discuss discussed mention
  mentioned answer answers answered question questions conversation chat last previous earlier today yesterday tomorrow week
  weeks month months year years day days monday tuesday wednesday thursday friday saturday sunday january february march april
  june july august september october november december change changed changes changing correct right true update updated
  updates anything something everything know please thanks thank want need tell give gave make made think thought time
  ago back recently remember recall one ones between`.split(/\s+/),
);

export function topicTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)))];
}

/**
 * Find the past exchanges this message is about.
 * `inContext` holds turns the model will already see as conversation history.
 */
export function recall(text: string, now: Date, tz: string, inContext: ReadonlySet<number> = new Set()): Recall {
  const refersToHistory = REFERS_TO_HISTORY.test(text);
  const terms = topicTerms(text);
  const fresh = (t: Turn) => !inContext.has(t.id);

  // Topic matches across all of memory, best first. Quoting makes each term a literal.
  const topical = terms.length > 0 ? turnsMatching(terms.map((t) => `"${t}"`).join(" OR "), 30).filter(fresh) : [];
  const topicRank = new Map(topical.map((t, i) => [t.id, i]));

  // Each date phrase can have more than one honest reading. Prefer the reading that holds an
  // exchange on the topic being asked about, then any reading that holds an exchange at all.
  const dates: Recall["dates"] = [];
  const dated = new Map<number, Turn>();
  for (const ref of resolveDates(text, now, tz)) {
    const candidates = ref.windows.map((window) => ({ window, turns: turnsInRange(window.from, window.to).filter(fresh) }));
    const chosen =
      candidates.find((c) => c.turns.some((t) => topicRank.has(t.id))) ?? candidates.find((c) => c.turns.length > 0);
    dates.push({ text: ref.text, window: (chosen ?? candidates[0]!).window, found: chosen !== undefined });
    for (const t of chosen?.turns ?? []) dated.set(t.id, t);
  }

  // "What did Apple announce last Tuesday?" has a date but is about the world, not about us.
  // Without a reference to our history, a date only recalls exchanges that are also on topic.
  if (!refersToHistory) {
    for (const id of dated.keys()) if (!topicRank.has(id)) dated.delete(id);
  }

  let ranked: Turn[];
  if (dated.size > 0) {
    // On-topic exchanges first, then the rest of that day in the order they happened.
    const rank = (t: Turn) => topicRank.get(t.id) ?? Number.MAX_SAFE_INTEGER;
    ranked = [...dated.values()].sort((a, b) => rank(a) - rank(b) || a.at - b.at);
  } else if (refersToHistory) {
    // No date, or nothing on that date: fall back to the closest exchanges by topic, and if
    // there are none, to the latest ones, so the model can say what it does have.
    ranked = topical.length > 0 ? topical.slice(0, 3) : [];
    if (ranked.length === 0) return { refersToHistory, dates, exchanges: [], mentions: recentTurns(5).filter(fresh) };
  } else {
    // An ordinary question. Surface clearly related history as one-liners only, and only when
    // it overlaps on two or more topic words, so unrelated memory stays out of the prompt.
    // Not in a follow-up, though: mid-conversation, "which of those would you pick?" points at
    // the conversation itself, and stray mentions of other chats made the model hedge about
    // which "those" was meant.
    const strong = inContext.size > 0 ? [] : topical.filter((t) => overlap(t, terms) >= Math.min(2, terms.length));
    return { refersToHistory, dates: [], exchanges: [], mentions: strong.slice(0, 3) };
  }

  return {
    refersToHistory,
    dates,
    exchanges: ranked.slice(0, FULL_EXCHANGES),
    mentions: ranked.slice(FULL_EXCHANGES, FULL_EXCHANGES + ONE_LINERS),
  };
}

function overlap(turn: Turn, terms: string[]): number {
  const haystack = `${turn.question} ${turn.summary} ${turn.entities}`.toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length;
}

/** The block placed in front of the user's message. Stored with the turn and replayed as is. */
export function renderContext(r: Recall, now: Date, tz: string): string {
  const lines = [`<context>`, `Now: ${formatDateTime(now, tz)} (${tz})`];
  const hasMemory = r.exchanges.length > 0 || r.mentions.length > 0;

  if (hasMemory || r.refersToHistory) {
    lines.push(`<memory>`);
    // How much is stored matters only when the lookup came up short: it lets the model say
    // "nothing on that date, though I do have history from X to Y". When the exchange was
    // found, the count is noise the model tends to repeat back.
    if (r.exchanges.length === 0 || r.dates.some((d) => !d.found)) {
      const stats = memoryStats();
      lines.push(
        stats.count === 0
          ? `Stored history: empty. There is no record of any earlier conversation.`
          : `Stored history: ${stats.count} exchanges in total, from ${formatDate(stats.first!)} to ${formatDate(stats.last!)}. Only those shown below are relevant to this message.`,
      );
    }
    for (const d of r.dates) {
      lines.push(
        d.found
          ? `"${d.text}" resolves to ${d.window.label}.`
          : `"${d.text}" resolves to ${d.window.label}. No exchange is stored for that date.`,
      );
    }
    if (r.dates.some((d) => !d.found) && r.exchanges.length > 0) {
      lines.push(`The exchanges below are the closest by topic, from other dates.`);
    }

    const today = localDate(now, tz);
    const claims = claimsFor(r.exchanges.map((t) => t.id));
    for (const t of r.exchanges) {
      const answer = t.answer ?? "";
      lines.push(`<exchange date="${formatDateTime(new Date(t.at), t.tz)}" age="${age(t.localDate, today)}">`);
      lines.push(`<asked>${t.question}</asked>`);
      lines.push(`<answered>${answer.length > ANSWER_CHARS ? `${answer.slice(0, ANSWER_CHARS)} [truncated]` : answer}</answered>`);
      if (t.sources.length > 0) {
        lines.push(`<sources_then>`, ...t.sources.map((s) => `[${s.n}] ${s.title} ${s.url}`), `</sources_then>`);
      }
      const own = claims.filter((c) => c.turnId === t.id).slice(0, CLAIMS_SHOWN);
      if (own.length > 0) {
        lines.push(`<claims_then>`, ...own.map((c) => `- ${c.entity} | ${c.attribute} | ${c.value} | ${c.sourceUrl}`), `</claims_then>`);
      }
      lines.push(`</exchange>`);
    }
    if (r.mentions.length > 0) {
      lines.push(r.exchanges.length > 0 ? `Other stored exchanges, in brief:` : `Stored exchanges that may be related, in brief:`);
      for (const t of r.mentions) {
        const gist = t.summary || (t.answer ?? "").replace(/\s+/g, " ").slice(0, 200);
        lines.push(`- ${formatDateTime(new Date(t.at), t.tz)} (${age(t.localDate, today)}): asked "${t.question.slice(0, 300)}" -> ${gist}`);
      }
    }
    lines.push(`</memory>`);
  }

  lines.push(`</context>`);
  return lines.join("\n");
}

function age(date: string, today: string): string {
  const days = Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000);
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
