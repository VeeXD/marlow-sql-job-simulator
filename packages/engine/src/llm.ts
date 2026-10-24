import { isAdversarialUser } from "./guardrails.js";
import { evaluateDraft } from "./guardrails.js";
import { buildSystemPrompt, buildUserPrompt, type PromptInput } from "./prompt.js";
import type { SqlExec } from "./sql.js";
import type { TimelineFact } from "./director.js";

export type LlmRequest = {
  model: "manager" | "teammate";
  system: string;
  user: string;
  fallback: string;
};

export interface LlmProvider {
  id: string;
  complete(req: LlmRequest): Promise<string>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createMockProvider(): LlmProvider {
  return {
    id: "mock",
    async complete(req) {
      if (isAdversarialUser(req.user)) return req.fallback;
      return req.fallback;
    },
  };
}

export function scriptedProvider(reply: string | ((req: LlmRequest) => string)): LlmProvider {
  return {
    id: "scripted",
    async complete(req) {
      return typeof reply === "function" ? reply(req) : reply;
    },
  };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  return res.json();
}

export function createOpenAiProvider(env: NodeJS.ProcessEnv): LlmProvider {
  const base = (env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const key = env.LLM_API_KEY || "";
  return {
    id: "openai",
    async complete(req) {
      if (!key) throw new Error("LLM_API_KEY is not set");
      const model = req.model === "manager" ? env.LLM_MODEL_MANAGER || "gpt-4o-mini" : env.LLM_MODEL_TEAMMATE || "gpt-4o-mini";
      const json = (await postJson(
        `${base}/chat/completions`,
        { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        {
          model,
          temperature: 0.4,
          max_tokens: 400,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        },
      )) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content;
      if (!text) throw new Error("LLM returned an empty reply");
      return text;
    },
  };
}

export function createAnthropicProvider(env: NodeJS.ProcessEnv): LlmProvider {
  const key = env.LLM_API_KEY || "";
  const base = (env.LLM_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  return {
    id: "anthropic",
    async complete(req) {
      if (!key) throw new Error("LLM_API_KEY is not set");
      const model = req.model === "manager" ? env.LLM_MODEL_MANAGER || "claude-3-5-haiku-latest" : env.LLM_MODEL_TEAMMATE || "claude-3-5-haiku-latest";
      const json = (await postJson(
        `${base}/v1/messages`,
        {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        {
          model,
          max_tokens: 400,
          temperature: 0.4,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        },
      )) as { content?: { text?: string }[] };
      const text = json.content?.map((part) => part.text ?? "").join("").trim();
      if (!text) throw new Error("LLM returned an empty reply");
      return text;
    },
  };
}

export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const kind = (env.LLM_PROVIDER || "mock").toLowerCase();
  if (kind === "openai") return createOpenAiProvider(env);
  if (kind === "anthropic") return createAnthropicProvider(env);
  return createMockProvider();
}

const SAFE_LINE =
  "I can talk about the Marlow landing zone, and I still won't write the query. The ERD lists `raw_orders` and `raw_events`.";

export async function wordReply(args: {
  provider: LlmProvider;
  prompt: PromptInput;
  fallback: string;
  facts: TimelineFact[];
  exec?: SqlExec;
  threshold?: number;
}): Promise<{ text: string; usedFallback: boolean; reasons: string[] }> {
  const system = buildSystemPrompt(args.prompt);
  const user = buildUserPrompt(args.prompt);
  let reasons: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let draft: string;
    try {
      draft = await args.provider.complete({
        model: args.prompt.personaId === "priya" ? "manager" : "teammate",
        system,
        user:
          attempt === 0
            ? user
            : `${user}\n\nYour previous reply was rejected (${reasons.join("; ")}). Stay in character. Do not write SQL.`,
        fallback: args.fallback,
      });
    } catch {
      return { text: args.fallback, usedFallback: true, reasons: ["provider_error"] };
    }
    const verdict = await evaluateDraft(draft, {
      facts: args.facts,
      userText: args.prompt.playerMessage,
      exec: args.exec,
      threshold: args.threshold,
    });
    if (verdict.ok) return { text: draft, usedFallback: false, reasons: [] };
    reasons = verdict.reasons;
  }
  const fallbackVerdict = await evaluateDraft(args.fallback, {
    facts: args.facts,
    userText: args.prompt.playerMessage,
    exec: args.exec,
    threshold: args.threshold,
  });
  if (!fallbackVerdict.ok) return { text: SAFE_LINE, usedFallback: true, reasons: fallbackVerdict.reasons };
  return { text: args.fallback, usedFallback: true, reasons };
}
