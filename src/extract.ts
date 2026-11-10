import { anthropic } from "./agent.ts";
import { config } from "./config.ts";
import { getTurn, setExtraction } from "./db.ts";

// After an answer has been sent, a small fast model reads the exchange and writes down what it
// asserted: a one-line summary, the things it was about, and each checkable fact with the page
// it came from. This runs in the background and the reply never waits for it.
//
// It is an enhancement, not a dependency. The exchange itself is stored and indexed the moment
// the answer completes, so recall works even if this step is slow or fails.

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One sentence: what was asked and what the answer concluded." },
    entities: {
      type: "array",
      items: { type: "string" },
      description: "Products, companies, people, places and technologies the exchange is about, including every item in any list or shortlist.",
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entity: { type: "string", description: "What the fact is about, e.g. 'Supabase'." },
          attribute: { type: "string", description: "Which property, e.g. 'Pro plan price'." },
          value: { type: "string", description: "The value as stated, with units, e.g. '$25/month'." },
          citation: { type: "integer", description: "The [n] citation number attached to this fact in the answer, or 0 if it had none." },
        },
        required: ["entity", "attribute", "value", "citation"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "entities", "claims"],
  additionalProperties: false,
};

const INSTRUCTIONS = `You are building the memory of a chat assistant. Below is one exchange: a user's question and the assistant's answer. Later the user may ask "has any of that changed?", and the assistant will re-check the answer against the web. Record what it will need for that.

For claims, list the facts in the answer that could be different next month: prices, plan names and limits, version numbers, release dates, availability, rankings, who holds a role, what a product includes. One fact per claim, at most 30, most important first. Copy values exactly as the answer states them. Leave out opinions, advice, and facts that do not change (definitions, history, arithmetic). If the answer has no such facts, return an empty list.`;

export async function extractMemory(turnId: number): Promise<void> {
  const turn = getTurn(turnId);
  if (!turn?.answer) return;

  const message = await anthropic.messages.create({
    model: config.extractModel,
    max_tokens: 4000,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: `${INSTRUCTIONS}\n\n<question>\n${turn.question}\n</question>\n\n<answer>\n${turn.answer}\n</answer>`,
      },
    ],
  });
  const text = message.content.find((block) => block.type === "text")?.text;
  if (message.stop_reason !== "end_turn" || !text) throw new Error(`extraction stopped with ${message.stop_reason}`);

  // The schema is enforced by the API, so the shape is known here.
  const out = JSON.parse(text) as {
    summary: string;
    entities: string[];
    claims: { entity: string; attribute: string; value: string; citation: number }[];
  };
  const urlByNumber = new Map(turn.sources.map((s) => [s.n, s.url]));
  setExtraction(
    turnId,
    out.summary,
    out.entities.join(", "),
    out.claims.slice(0, 30).map((c) => ({
      entity: c.entity,
      attribute: c.attribute,
      value: c.value,
      sourceUrl: urlByNumber.get(c.citation) ?? "",
    })),
  );
}
