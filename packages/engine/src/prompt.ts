import type { Difficulty, PersonaId } from "./types.js";
import { CAST_BY_ID, SCHEMA_CATALOG, type Persona } from "./world.js";

export type PromptInput = {
  personaId: PersonaId;
  intent: string;
  allowedFacts: string[];
  playerName: string;
  difficulty: Difficulty;
  history: { author: string; body: string }[];
  playerMessage?: string;
  schema?: { table: string; columns: string[] }[];
};

const REFUSAL =
  "Write 2 to 5 sentences, in character, at Marlow. Never write SQL. Never give a numbered recipe for the transform. Mention a table or column only if it is in the schema list, and wrap every one of those names in backticks. If you do not know, say so and point at the ERD.";

export function redactSql(text: string): string {
  const withoutFences = text.replace(/```[\s\S]*?```/g, "[sql omitted]");
  return withoutFences
    .split("\n")
    .map((line) => (/^\s*(select|with|create|insert|update|delete|drop|alter)\b/i.test(line) || /row_number\s*\(/i.test(line) ? "[sql omitted]" : line))
    .join("\n")
    .slice(0, 1200);
}

export function buildSystemPrompt(input: PromptInput): string {
  const persona: Persona = CAST_BY_ID[input.personaId];
  const schema = input.schema ?? SCHEMA_CATALOG;
  const schemaLines = schema.map((t) => `- \`${t.table}\` (${t.columns.map((c) => `\`${c}\``).join(", ")})`).join("\n");
  return [
    `You are ${persona.name}, ${persona.role} at Marlow, an e-commerce home-goods company.`,
    persona.voice,
    `Pronouns: ${persona.pronouns}.`,
    `Intent: ${input.intent}`,
    `Difficulty the player chose: ${input.difficulty}. Guided players get shorter hints about where to look, never the query.`,
    "Allowed facts:",
    ...input.allowedFacts.map((f) => `- ${f}`),
    "Schema (the only identifiers you may mention):",
    schemaLines,
    REFUSAL,
  ].join("\n");
}

export function buildUserPrompt(input: PromptInput): string {
  const history = input.history
    .slice(-8)
    .map((m) => `${m.author}: ${redactSql(m.body)}`)
    .join("\n");
  const player = input.playerMessage ? redactSql(input.playerMessage) : "";
  return [
    history ? `Recent conversation:\n${history}` : "No earlier messages.",
    player ? `The player just said:\n${player}` : "Say the next thing this intent calls for. Do not wait for a question.",
    `Address ${input.playerName} naturally.`,
  ].join("\n\n");
}

export function renderPrompt(input: PromptInput): string {
  return `${buildSystemPrompt(input)}\n\n${buildUserPrompt(input)}`;
}
