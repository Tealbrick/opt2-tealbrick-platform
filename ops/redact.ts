// One redaction pass for every ops script that prints or throws text from a CLI, an API or a log (Railway, Stripe,
// Woodpecker, the registry). Before this module each script had its own copy with its own rules, so a token that one
// copy masked another printed (the Stripe/webhook/bearer patterns lived only in wp-failed, the Authorization header
// rule only in site-deploy-plugin-publish, the value-length floor was 4 in one copy and 8 in another).
// ops/site-deploy-plugin/site-deploy.ts keeps its own copy: that directory is a separate image build context.

/** Patterns that must never reach a terminal: GitHub tokens and PATs, Stripe keys, webhook secrets, bearer and Authorization headers. */
const PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\b(?:rk|sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bwhsec_[A-Za-z0-9]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
const AUTH_HEADER = /(authorization:\s*)\S+(\s+\S+)?/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// terminal control sequences (colours, cursor moves, OSC titles) never reach the reader's terminal
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Values shorter than this are not replaced (a 1-3 character "secret" would blank ordinary words). */
export const MIN_SECRET_LENGTH = 4;
export const MASK = "[redacted]";

/**
 * Removes the given secret values (and each line of a multi-line one) and anything token-shaped from a text, and
 * strips terminal control sequences. Safe on ordinary text: it changes nothing that matches no rule.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(CONTROL, "").replace(PRIVATE_KEY, MASK);
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join(MASK);
    for (const line of secret.split(/\r?\n/)) if (line.trim().length >= 12) out = out.split(line.trim()).join(MASK);
  }
  for (const re of PATTERNS) out = out.replace(re, MASK);
  return out.replace(AUTH_HEADER, `$1${MASK}`);
}
