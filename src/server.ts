import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { type ChatEvent, chatTurn } from "./chat.ts";
import { validTz } from "./clock.ts";
import { config, missingKeys } from "./config.ts";
import { conversationTurns, listConversations } from "./db.ts";
import { extractMemory } from "./extract.ts";
import { importHistory } from "./import.ts";

// Plain node:http. There are five routes and one of them streams; a framework would add more
// to explain than it would save.

// Files the browser may fetch. A fixed map, so no request path ever reaches the filesystem.
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "public/index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "public/app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "public/style.css", type: "text/css; charset=utf-8" },
  "/vendor/marked.js": { file: "node_modules/marked/lib/marked.esm.js", type: "text/javascript; charset=utf-8" },
  "/vendor/purify.js": { file: "node_modules/dompurify/dist/purify.es.mjs", type: "text/javascript; charset=utf-8" },
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Expected a JSON object or array.");
  return parsed as Record<string, unknown>;
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, 1_000_000);
  const question = typeof body.message === "string" ? body.message.trim() : "";
  if (!question) return sendJson(res, 400, { error: "`message` is required." });
  if (missingKeys().length > 0) {
    return sendJson(res, 503, { error: `Missing ${missingKeys().join(" and ")}. Copy .env.example to .env, fill it in, and restart.` });
  }
  const conversationId = typeof body.conversationId === "string" && body.conversationId ? body.conversationId : randomUUID();

  // Server-sent events: one JSON object per event, in the order things happen.
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const send = (event: ChatEvent | { type: "start"; conversationId: string } | { type: "error"; message: string }) =>
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: "start", conversationId });

  // If the user closes the tab or presses stop, stop paying for the model and the searches.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    await chatTurn(conversationId, question, validTz(body.tz), send, abort.signal);
  } catch (error) {
    if (!abort.signal.aborted) {
      console.error("[chat]", error);
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  res.end();
}

async function handleImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const turnIds = importHistory(await readJson(req, 20_000_000));
  sendJson(res, 200, { imported: turnIds.length });
  // Summaries and claims for the imported turns, one at a time, after responding.
  if (config.anthropicKey) {
    for (const id of turnIds) await extractMemory(id).catch((error: Error) => console.error(`[import] turn ${id}: ${error.message}`));
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "POST" && pathname === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && pathname === "/api/import") return await handleImport(req, res);
    if (req.method === "GET" && pathname === "/api/state") {
      return sendJson(res, 200, { missingKeys: missingKeys(), model: config.agentModel, conversations: listConversations() });
    }
    if (req.method === "GET" && pathname.startsWith("/api/conversations/")) {
      const turns = conversationTurns(decodeURIComponent(pathname.slice("/api/conversations/".length)));
      return sendJson(res, 200, turns.map(({ id, at, question, answer, sources }) => ({ id, at, question, answer, sources })));
    }
    const asset = req.method === "GET" ? STATIC[pathname] : undefined;
    if (asset) {
      res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" });
      return res.end(await readFile(asset.file));
    }
    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    console.error("[server]", error);
    if (res.headersSent) res.end();
    else sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(config.port, () => {
  console.log(`\n  Chat agent ready: http://localhost:${config.port}\n  Model: ${config.agentModel} (effort ${config.agentEffort})`);
  if (missingKeys().length > 0) {
    console.log(`\n  Missing ${missingKeys().join(" and ")}. Copy .env.example to .env, fill it in, and restart.`);
  }
  console.log();
});
