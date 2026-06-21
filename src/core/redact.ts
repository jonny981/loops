/**
 * Best-effort secret scrubbing for text that flows into events / logs / the
 * exit summary (e.g. a subprocess's stderr, which we don't control). Not a
 * security boundary — a guard against accidental credential echo.
 */

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // emails
  /\b(api[_-]?key|token|secret|password|authorization|bearer)\b\s*[=:]\s*\S+/gi, // key=value creds
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}
