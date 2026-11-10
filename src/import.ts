import { randomUUID } from "node:crypto";
import { localDate, validTz } from "./clock.ts";
import { completeTurn, insertTurn, upsertConversation } from "./db.ts";

// Loads dated conversations from elsewhere into memory, so questions about "last Tuesday" can
// be tested without waiting a week. Accepted shape:
//
//   { "tz": "Asia/Kolkata",
//     "conversations": [ { "messages": [
//        { "role": "user",      "content": "...", "at": "2026-11-03T10:00:00+05:30" },
//        { "role": "assistant", "content": "..." } ] } ] }
//
// A bare array of conversations, or a bare array of messages, is accepted too.

const TIME_KEYS = ["at", "timestamp", "created_at", "createdAt", "date", "time"];

interface Message {
  role: string;
  content: string;
  at: number | null;
}

function readMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  const messages: Message[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item.role !== "string" || typeof item.content !== "string") continue;
    const stamp = TIME_KEYS.map((key) => item[key]).find((v) => typeof v === "string" || typeof v === "number");
    const at = stamp === undefined ? Number.NaN : new Date(stamp as string | number).getTime();
    messages.push({ role: item.role, content: item.content, at: Number.isNaN(at) ? null : at });
  }
  return messages;
}

/** Returns the ids of the turns created. Throws if the data holds no dated user message. */
export function importHistory(data: unknown): number[] {
  const root = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const tz = validTz(root.tz);
  const list = Array.isArray(data) ? data : Array.isArray(root.conversations) ? root.conversations : [];
  // An array whose items have a role is one conversation's messages, not a list of conversations.
  const isMessages = list.some((item) => item && typeof item === "object" && "role" in item);
  const conversations: unknown[] = isMessages ? [{ messages: list }] : list;

  const turnIds: number[] = [];
  for (const conversation of conversations as Record<string, unknown>[]) {
    const messages = readMessages(conversation?.messages);
    const conversationId = randomUUID();
    for (let i = 0; i < messages.length - 1; i++) {
      const [asked, answered] = [messages[i]!, messages[i + 1]!];
      if (asked.role !== "user" || answered.role !== "assistant" || asked.at === null) continue;
      upsertConversation(conversationId, asked.content.replace(/\s+/g, " ").slice(0, 80), asked.at);
      const id = insertTurn({
        conversationId,
        at: asked.at,
        localDate: localDate(new Date(asked.at), tz),
        tz,
        question: asked.content,
        context: "",
      });
      completeTurn(id, answered.content, []);
      turnIds.push(id);
    }
  }
  if (turnIds.length === 0) {
    throw new Error(`Nothing to import: expected user messages with a timestamp (${TIME_KEYS.join(", ")}) each followed by an assistant message.`);
  }
  return turnIds;
}
