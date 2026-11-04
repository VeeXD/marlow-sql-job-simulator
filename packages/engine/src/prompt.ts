import { GLOSSARY } from "./glossary.js";
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
  "Write like a coworker in chat, not a memo. Plain conversational English a new analyst can follow. One or two short sentences. Say enough that a beginner knows what you mean. A filler is fine (yeah, okay so, honestly). Do not add an emoji. Priya sounds like a manager, Jonah like the teammate who owns the files, Sam and Riley like consumers who do not know the SQL. When you use a specialist word (churn, ETL, DAG, grain, landing zone, pipeline, timestamptz, AOV), explain it in the same message in a few everyday words. Guided players always get that definition. If you already explained the word earlier in the conversation, do not define it again. Never write SQL. Never give a numbered recipe for the transform. Mention a table or column only if it is in the schema list, and wrap every one of those names in backticks. If you do not know, say so and point at the ERD.";

export { GLOSSARY } from "./glossary.js";

/** Explain at most one new term, so a line stays short. Mock mode speaks this sentence as part of the fallback. */
export function glossText(
  body: string,
  difficulty: Difficulty,
  explained: string[],
): { body: string; explained: string[] } {
  const next = [...explained];
  for (const entry of GLOSSARY) {
    if (!entry.speak) continue;
    if (!entry.regex.test(body)) continue;
    if (next.includes(entry.id)) continue;
    if (entry.speak.skipIf?.test(body)) {
      next.push(entry.id);
      continue;
    }
    const note = difficulty === "guided" ? entry.speak.guided : entry.speak.standard;
    next.push(entry.id);
    return { body: `${body} ${note}`, explained: next };
  }
  return { body, explained: next };
}

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
    `Difficulty the player chose: ${input.difficulty}. Guided players get a plain-language definition the first time you use a specialist word, and a shorter hint about where to look. Never the query. Standard players still get the definition once, in fewer words.`,
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
