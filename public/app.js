import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

const $ = (id) => document.getElementById(id);
const thread = $("thread");
const input = $("input");
const sendButton = $("send");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

let conversationId = null;
/** AbortController of the reply being streamed, if any. */
let inFlight = null;
/** The last day a day-mark was drawn for, so each day is labelled once. */
let lastDay = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dayLabel(ms) {
  const day = new Date(ms).toDateString();
  if (day === new Date().toDateString()) return "Today";
  if (day === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Model output is untrusted: markdown -> HTML -> sanitised, then [n] markers become links. */
function renderAnswer(node, markdown, sources) {
  node.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { breaks: false, gfm: true }));
  for (const a of node.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const text of texts) {
    if (text.parentElement.closest("code, pre, a") || !/\[\d+\]/.test(text.data)) continue;
    const fragment = document.createDocumentFragment();
    for (const part of text.data.split(/(\[\d+\])/)) {
      const source = /^\[\d+\]$/.test(part) ? sources.get(Number(part.slice(1, -1))) : undefined;
      if (!source) {
        fragment.append(part);
        continue;
      }
      const a = el("a", "cite", String(source.n));
      a.href = source.url;
      a.title = `${source.title}\n${hostOf(source.url)}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      fragment.append(a);
    }
    text.replaceWith(fragment);
  }
}

function scrollToEnd(force) {
  const nearEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
  if (force || nearEnd) thread.scrollTop = thread.scrollHeight;
}

function addUserMessage(text, ms) {
  $("welcome")?.remove();
  const day = dayLabel(ms);
  if (day !== lastDay) {
    thread.append(el("div", "day-mark", day));
    lastDay = day;
  }
  const row = el("div", "user");
  row.append(el("div", "", text));
  thread.append(row);
}

/** One assistant reply: a trail of what it did, the answer, its sources. */
function addAssistantMessage() {
  const root = el("div", "assistant");
  const trail = el("div", "trail");
  const answer = el("div", "answer");
  const sourceList = el("div", "sources");
  const meta = el("div", "meta");
  root.append(trail, answer, sourceList, meta);
  thread.append(root);

  const sources = new Map();
  let text = "";
  let frame = 0;

  function trailLine(icon, className) {
    const line = el("div", className);
    const body = el("span");
    line.append(el("span", "icon", icon), body);
    trail.append(line);
    return body;
  }

  function draw() {
    frame = 0;
    renderAnswer(answer, text, sources);
    scrollToEnd(false);
  }

  return {
    handle(event) {
      if (event.type === "recall") {
        for (const d of event.dates) {
          trailLine(d.found ? "\u2713" : "!", `recall ${d.found ? "found" : "missing"}`).textContent = d.found
            ? `\u201C${d.text}\u201D is ${d.label}`
            : `\u201C${d.text}\u201D is ${d.label}: nothing stored for that date`;
        }
        for (const x of event.exchanges) {
          const body = trailLine("\u21BA", "recall found");
          body.append(`Recalled from ${x.date}: `, el("q", "", x.question.length > 110 ? `${x.question.slice(0, 110)}\u2026` : x.question));
        }
      } else if (event.type === "text") {
        text += event.text;
        // At most one markdown render per frame, however fast tokens arrive.
        frame ||= requestAnimationFrame(draw);
      } else if (event.type === "note") {
        if (text.trim()) trailLine("\u2022", "").textContent = text.trim();
        text = "";
        answer.replaceChildren();
      } else if (event.type === "searching") {
        const body = trailLine("\u25CF", "pending");
        body.textContent = `Searching: ${event.searches.map((s) => (s.domains.length ? `${s.query} (${s.domains.join(", ")})` : s.query)).join("  \u00B7  ")}`;
      } else if (event.type === "sources") {
        for (const s of event.sources) sources.set(s.n, s);
        const pending = trail.querySelector(".pending");
        if (pending) {
          pending.className = "";
          pending.querySelector(".icon").textContent = "\u2315";
          pending.lastChild.textContent = pending.lastChild.textContent.replace(/^Searching/, "Searched");
        }
      } else if (event.type === "done") {
        this.finish(event.answer, event.sources);
        const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
        meta.textContent = [
          seconds(event.ms),
          event.firstTextMs === null ? null : `first words at ${seconds(event.firstTextMs)}`,
          event.searches ? `${event.searches} ${event.searches === 1 ? "search" : "searches"}` : "no search",
        ]
          .filter(Boolean)
          .join("  \u00B7  ");
      } else if (event.type === "error") {
        this.fail(event.message);
      }
      scrollToEnd(false);
    },
    finish(finalText, cited) {
      cancelAnimationFrame(frame);
      for (const s of cited) sources.set(s.n, s);
      renderAnswer(answer, finalText, sources);
      for (const s of cited) {
        const a = el("a", "", `${s.n}  ${hostOf(s.url)}`);
        a.href = s.url;
        a.title = s.title;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        sourceList.append(a);
      }
    },
    fail(message) {
      cancelAnimationFrame(frame);
      trail.querySelector(".pending")?.classList.remove("pending");
      root.append(el("div", "error", message));
    },
  };
}

async function send(message) {
  if (inFlight || !message.trim()) return;
  inFlight = new AbortController();
  sendButton.textContent = "Stop";
  addUserMessage(message, Date.now());
  const reply = addAssistantMessage();
  scrollToEnd(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, message, tz }),
      signal: inFlight.signal,
    });
    if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);

    // Server-sent events over fetch: events are separated by a blank line.
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "start") conversationId = event.conversationId;
        else reply.handle(event);
      }
    }
  } catch (error) {
    reply.fail(error.name === "AbortError" ? "Stopped." : error.message);
  } finally {
    inFlight = null;
    sendButton.textContent = "Send";
    loadSidebar();
  }
}

async function loadSidebar() {
  const state = await (await fetch("/api/state")).json();
  const banner = $("banner");
  banner.hidden = state.missingKeys.length === 0;
  banner.textContent = `Missing ${state.missingKeys.join(" and ")}. Copy .env.example to .env, fill it in, and restart.`;

  const nav = $("conversations");
  nav.replaceChildren();
  let day = null;
  for (const c of state.conversations) {
    const label = dayLabel(c.updatedAt);
    if (label !== day) nav.append(el("div", "day", (day = label)));
    const button = el("button", c.id === conversationId ? "active" : "", c.title);
    button.type = "button";
    button.title = c.title;
    button.onclick = () => openConversation(c.id);
    nav.append(button);
  }
}

async function openConversation(id) {
  if (inFlight) return;
  const turns = await (await fetch(`/api/conversations/${encodeURIComponent(id)}`)).json();
  conversationId = id;
  lastDay = null;
  thread.replaceChildren();
  for (const turn of turns) {
    addUserMessage(turn.question, turn.at);
    const reply = addAssistantMessage();
    if (turn.answer === null) reply.fail("No answer was recorded for this message.");
    else reply.finish(turn.answer, turn.sources);
  }
  scrollToEnd(true);
  loadSidebar();
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (inFlight) return inFlight.abort();
  const message = input.value;
  input.value = "";
  input.style.height = "auto";
  send(message);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});

$("new-chat").addEventListener("click", () => {
  if (!inFlight) location.reload();
});

for (const button of document.querySelectorAll("#suggestions button")) {
  button.addEventListener("click", () => send(button.textContent));
}

loadSidebar();
