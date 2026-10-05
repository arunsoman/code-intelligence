// Private-prompt redaction (plan §2.3, AT-35, AT-44). Deterministic code, not a model decision: whatever leaves the request
// record toward an issue, a log or a preview passes through here. It is conservative (it masks more than it must).
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[aws key id]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[github token]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[api key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[slack token]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/gi, "Bearer [token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[jwt]"],
  [/\b(pass(?:word|wd)?|secret|token|api[_-]?key|auth|credential)s?\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[number]"],
  [/\b[0-9a-fA-F]{32,}\b/g, "[hex]"],
  [/\b[A-Za-z0-9+\/]{40,}={0,2}(?![A-Za-z0-9+\/])/g, "[opaque]"],
];

export function redactText(text: string): string { let out = text; for (const [re, to] of RULES) out = out.replace(re, to); return out; }

/** A single-line preview for lists and issue titles: redacted first, then shortened, so a cut can never split a secret. */
export function redactedPreview(text: string, max = 120): string {
  const one = redactText(text).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}
