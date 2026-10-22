// Heuristic prompt-injection detector for the text that led an agent to pay.
// It is a floor, not a ceiling: an optional LLM check can only raise the score.

export interface Signal {
  id: string;
  points: number;
  detail?: string;
}

const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
const ZERO_WIDTH = /[​-‏⁠﻿]/g;
const BIDI = /[‪-‮⁦-⁩]/g;

const OVERRIDE_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|guidelines?)/i,
  /\bnew (instructions?|task|objective)\s*[:\-]/i,
  /\b(system|developer)\s*(prompt|message|override|mode)\b/i,
  /\byou are now\b|\bfrom now on,? you\b|\bact as (an?|the)\b/i,
  /<\/?(system|assistant|instructions?)>/i,
  /\[\s*(system|admin|important)\s*\]/i,
];

const SECRECY = /\b(do not|don't|never)\s+(tell|inform|mention|alert|notify|ask)\b[^.\n]{0,30}\b(user|owner|human)\b|\bwithout (asking|confirmation|approval|telling)\b/i;
const PAYMENT_DEMAND = /\b(send|transfer|pay|wire|move|deposit)\b[^.\n]{0,40}\b\d[\d.,]*\s*(usdc|usdt|dai|near|eth|btc|sol|tokens?)?\b[^.\n]{0,40}\b(to|into|→)\b/i;
const URGENCY = /\b(immediately|right now|urgent(ly)?|asap|within \d+ (seconds|minutes)|or (else|lose|your account))\b/i;
const HIDDEN_HTML = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?![.\d])|<!--[\s\S]*?-->/i;
const LONG_BASE64 = /[A-Za-z0-9+/]{120,}={0,2}/;

/** Text an LLM would see after Unicode tag characters are decoded to ASCII. */
export function revealHidden(text: string): string {
  return text.replace(TAG_CHARS, (c) => {
    const cp = c.codePointAt(0)! - 0xe0000;
    return cp >= 0x20 && cp <= 0x7e ? String.fromCharCode(cp) : "";
  });
}

export function scanContext(context: string, recipientAddress: string): Signal[] {
  if (!context.trim()) return [];
  const signals: Signal[] = [];
  const tagCount = context.match(TAG_CHARS)?.length ?? 0;
  if (tagCount > 0) signals.push({ id: "hidden_unicode_tags", points: 60, detail: `${tagCount} tag chars` });
  const zw = context.match(ZERO_WIDTH)?.length ?? 0;
  if (zw >= 3) signals.push({ id: "zero_width_chars", points: 20, detail: `${zw} chars` });
  if (BIDI.test(context)) signals.push({ id: "bidi_override", points: 25 });

  // Check the decoded text too: hidden instructions are the ones that matter most.
  const text = revealHidden(context).replace(ZERO_WIDTH, "");
  const overrides = OVERRIDE_PATTERNS.filter((p) => p.test(text)).length;
  if (overrides > 0) signals.push({ id: "instruction_override", points: Math.min(35 * overrides, 70) });
  if (SECRECY.test(text)) signals.push({ id: "secrecy_demand", points: 30 });
  const demand = PAYMENT_DEMAND.test(text);
  if (demand) signals.push({ id: "payment_demand", points: 15 });
  if (demand && URGENCY.test(text)) signals.push({ id: "urgency_pressure", points: 15 });
  if (HIDDEN_HTML.test(text) && demand) signals.push({ id: "hidden_html_payment", points: 25 });
  if (LONG_BASE64.test(text)) signals.push({ id: "encoded_blob", points: 10 });

  // The payee came from the untrusted text itself. Alone it is normal (an invoice names
  // its payee), together with any other signal it is the classic injection shape.
  const addr = recipientAddress.toLowerCase();
  if (addr.length >= 6 && text.toLowerCase().includes(addr) && signals.length > 0) {
    signals.push({ id: "payee_from_suspicious_text", points: 25 });
  }
  return signals;
}
