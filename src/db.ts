import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

// One table carries both chat history and memory: a "turn" is one user question plus the
// answer it got. Memory is the same rows viewed by date and topic, so there is nothing to sync.

export interface Source {
  n: number;
  url: string;
  title: string;
}

export interface Turn {
  id: number;
  conversationId: string;
  /** Unix ms when the user asked. */
  at: number;
  /** The asker's civil date, YYYY-MM-DD in their timezone at the time. */
  localDate: string;
  tz: string;
  question: string;
  /** The context block the harness put in front of the question; replayed verbatim. */
  context: string;
  /** Null while the answer is being written, or if the turn failed. */
  answer: string | null;
  sources: Source[];
  /** Filled in by background extraction; empty until then. */
  summary: string;
  entities: string;
}

export interface Claim {
  turnId: number;
  entity: string;
  attribute: string;
  value: string;
  sourceUrl: string;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
}

if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    at INTEGER NOT NULL,
    local_date TEXT NOT NULL,
    tz TEXT NOT NULL,
    question TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    answer TEXT,
    sources TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '',
    entities TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS turns_by_date ON turns(local_date);
  CREATE INDEX IF NOT EXISTS turns_by_conversation ON turns(conversation_id, id);

  -- Topic index over answered turns. rowid = turns.id.
  CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
    question, answer, summary, entities, tokenize = 'porter unicode61'
  );

  -- What an answer asserted, one checkable fact per row, each tied to the page it came from.
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY,
    turn_id INTEGER NOT NULL REFERENCES turns(id),
    entity TEXT NOT NULL,
    attribute TEXT NOT NULL,
    value TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS claims_by_turn ON claims(turn_id);

  CREATE TABLE IF NOT EXISTS search_cache (
    key TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    results TEXT NOT NULL
  );
`);

interface TurnRow {
  id: number;
  conversation_id: string;
  at: number;
  local_date: string;
  tz: string;
  question: string;
  context: string;
  answer: string | null;
  sources: string;
  summary: string;
  entities: string;
}

function toTurn(row: unknown): Turn {
  // Rows come from our own schema above; node:sqlite types them as a loose record.
  const r = row as TurnRow;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    at: r.at,
    localDate: r.local_date,
    tz: r.tz,
    question: r.question,
    context: r.context,
    answer: r.answer,
    sources: JSON.parse(r.sources),
    summary: r.summary,
    entities: r.entities,
  };
}

// --- conversations ---

export function listConversations(): Conversation[] {
  return db
    .prepare("SELECT id, title, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC")
    .all() as unknown as Conversation[];
}

export function upsertConversation(id: string, title: string, at: number): void {
  // The title is set by the first question and never rewritten.
  db.prepare(
    `INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = max(updated_at, excluded.updated_at)`,
  ).run(id, title, at);
}

// --- turns ---

export function insertTurn(t: Pick<Turn, "conversationId" | "at" | "localDate" | "tz" | "question" | "context">): number {
  const result = db
    .prepare("INSERT INTO turns (conversation_id, at, local_date, tz, question, context) VALUES (?, ?, ?, ?, ?, ?)")
    .run(t.conversationId, t.at, t.localDate, t.tz, t.question, t.context);
  return Number(result.lastInsertRowid);
}

/** Store the answer and make the turn findable by topic. */
export function completeTurn(id: number, answer: string, sources: Source[]): void {
  db.prepare("UPDATE turns SET answer = ?, sources = ? WHERE id = ?").run(answer, JSON.stringify(sources), id);
  indexTurn(id);
}

export function setExtraction(id: number, summary: string, entities: string, claims: Omit<Claim, "turnId">[]): void {
  db.prepare("UPDATE turns SET summary = ?, entities = ? WHERE id = ?").run(summary, entities, id);
  db.prepare("DELETE FROM claims WHERE turn_id = ?").run(id);
  const insert = db.prepare("INSERT INTO claims (turn_id, entity, attribute, value, source_url) VALUES (?, ?, ?, ?, ?)");
  for (const c of claims) insert.run(id, c.entity, c.attribute, c.value, c.sourceUrl);
  indexTurn(id);
}

function indexTurn(id: number): void {
  db.prepare("DELETE FROM turns_fts WHERE rowid = ?").run(id);
  db.prepare(
    "INSERT INTO turns_fts (rowid, question, answer, summary, entities) SELECT id, question, answer, summary, entities FROM turns WHERE id = ?",
  ).run(id);
}

export function getTurn(id: number): Turn | undefined {
  const row = db.prepare("SELECT * FROM turns WHERE id = ?").get(id);
  return row && toTurn(row);
}

/** All turns of a conversation, oldest first, including unanswered ones. */
export function conversationTurns(conversationId: string): Turn[] {
  return db.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY id").all(conversationId).map(toTurn);
}

// --- memory queries: answered turns only ---

export function turnsInRange(from: string, to: string): Turn[] {
  return db
    .prepare("SELECT * FROM turns WHERE answer IS NOT NULL AND local_date BETWEEN ? AND ? ORDER BY at")
    .all(from, to)
    .map(toTurn);
}

/**
 * Best topic matches, best first. `match` is an FTS5 query. The weights favour the
 * question, the summary and the entity list over the long answer body.
 */
export function turnsMatching(match: string, limit: number): Turn[] {
  return db
    .prepare(
      `SELECT t.* FROM turns_fts f JOIN turns t ON t.id = f.rowid
       WHERE turns_fts MATCH ? ORDER BY bm25(turns_fts, 4.0, 1.0, 3.0, 5.0) LIMIT ?`,
    )
    .all(match, limit)
    .map(toTurn);
}

export function recentTurns(limit: number): Turn[] {
  return db.prepare("SELECT * FROM turns WHERE answer IS NOT NULL ORDER BY at DESC LIMIT ?").all(limit).map(toTurn);
}

export function memoryStats(): { count: number; first: string | null; last: string | null } {
  return db
    .prepare("SELECT count(*) AS count, min(local_date) AS first, max(local_date) AS last FROM turns WHERE answer IS NOT NULL")
    .get() as unknown as { count: number; first: string | null; last: string | null };
}

export function claimsFor(turnIds: number[]): Claim[] {
  if (turnIds.length === 0) return [];
  return db
    .prepare(
      `SELECT turn_id AS turnId, entity, attribute, value, source_url AS sourceUrl
       FROM claims WHERE turn_id IN (${turnIds.map(() => "?").join(",")}) ORDER BY id`,
    )
    .all(...turnIds) as unknown as Claim[];
}

/** Forget every conversation. The evals call this between scenarios; the app never does. */
export function clearMemory(): void {
  db.exec("DELETE FROM claims; DELETE FROM turns_fts; DELETE FROM turns; DELETE FROM conversations;");
}

// --- search cache ---

export function cachedSearch(key: string, maxAgeMs: number, nowMs: number): string | undefined {
  const row = db.prepare("SELECT at, results FROM search_cache WHERE key = ?").get(key) as
    | { at: number; results: string }
    | undefined;
  return row && nowMs - row.at >= 0 && nowMs - row.at < maxAgeMs ? row.results : undefined;
}

export function cacheSearch(key: string, results: string, nowMs: number): void {
  db.prepare("INSERT OR REPLACE INTO search_cache (key, at, results) VALUES (?, ?, ?)").run(key, nowMs, results);
}
