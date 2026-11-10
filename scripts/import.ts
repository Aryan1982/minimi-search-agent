import { readFileSync } from "node:fs";
import { config } from "../src/config.ts";
import { extractMemory } from "../src/extract.ts";
import { importHistory } from "../src/import.ts";

// Load dated conversations into memory: npm run import -- history.json
// The accepted JSON shape is described at the top of src/import.ts.

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run import -- <file.json>");
  process.exit(1);
}

const turnIds = importHistory(JSON.parse(readFileSync(file, "utf8")));
console.log(`Imported ${turnIds.length} exchanges.`);

if (config.anthropicKey) {
  for (const id of turnIds) await extractMemory(id).catch((error: Error) => console.error(`turn ${id}: ${error.message}`));
  console.log("Extracted summaries and claims.");
}
