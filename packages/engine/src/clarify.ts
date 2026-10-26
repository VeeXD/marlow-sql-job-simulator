/** True when the player asks the scripted question that unlocks the order definition. */
export function isOrderDefinitionQuestion(text: string): boolean {
  const t = text.toLowerCase().replace(/`/g, "");
  if (/what counts as an order/.test(t)) return true;
  if (/definition of (an )?order/.test(t)) return true;
  if (/which orders (belong|go|should|count|are)/.test(t)) return true;
  const aboutMembership = /refund|cancel/.test(t);
  const aboutRule = /exclude|include|count|belong|drop|remove|keep|leave out|part of|clean_orders|should/.test(t);
  return aboutMembership && aboutRule;
}

export function isStatusUpdate(text: string): boolean {
  return /status|running late|delay|blocked|heads up|shipped|landed|i(?:'ll| will) be late|pushed the/.test(
    text.toLowerCase(),
  );
}

export function isSuggestion(text: string): boolean {
  return /suggest|we should|what if we|could we/.test(text.toLowerCase());
}

export function isDelayFlag(text: string): boolean {
  return /running late|delay|i(?:'ll| will) be late|pushed the|might miss|won't make the due/.test(text.toLowerCase());
}
