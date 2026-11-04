import type { HeldLine } from "./types.js";

export const BURST_LIMIT = 3;

export const PLAYER_REACTIONS = ["👍", "👀", "🎉", "❓", "❤️"] as const;

export function splitSentences(body: string): string[] {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const parts = text.match(/[^.!?]+(?:[.!?]+["']?|$)/g)?.map((part) => part.trim()).filter(Boolean);
  return parts?.length ? parts : [text];
}

/**
 * Short lines for one beat.
 * With `hold`, only `max` lines are spoken now and the rest wait for the player.
 * Without `hold`, extra sentences are folded into the last line so nothing is dropped and the beat stays within `max`.
 */
export function paceLines(
  lines: HeldLine[],
  max = BURST_LIMIT,
  hold = false,
): { now: HeldLine[]; later: HeldLine[] } {
  const expanded: HeldLine[] = [];
  for (const line of lines) {
    const sentences = line.intact ? [line.body.trim()] : splitSentences(line.body);
    sentences.forEach((body, index) => {
      expanded.push({
        ...line,
        body,
        intent: index === 0 ? line.intent : `${line.intent}_cont`,
        playerMessage: index === 0 ? line.playerMessage : undefined,
        replyToId: index === 0 ? line.replyToId : undefined,
        intact: undefined,
      });
    });
  }
  if (expanded.length <= max) return { now: expanded, later: [] };
  if (hold) return { now: expanded.slice(0, max), later: expanded.slice(max) };
  const head = expanded.slice(0, max - 1);
  const tail = expanded.slice(max - 1);
  const merged: HeldLine = { ...tail[0], body: tail.map((line) => line.body).join(" ") };
  return { now: [...head, merged], later: [] };
}

export function isAck(body: string): boolean {
  return /^(ok|okay|k|kk|go on|next|continue|got it|thanks|thank you|cool|sounds good|yep|yeah|yes|sure)[.!\s]*$/i.test(
    body.trim(),
  );
}

/** About one player message in eleven. Deterministic so tests can find it. */
export function rareReaction(messageId: string): boolean {
  let hash = 2166136261;
  for (let i = 0; i < messageId.length; i++) {
    hash ^= messageId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 11 === 0;
}
