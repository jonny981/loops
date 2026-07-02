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

/**
 * Scrub exact occurrences of injected env values from captured output. Shape
 * patterns cannot catch a pinned credential that doesn't look like one (a hex
 * token in an innocently named var, a password inside a `postgres://` URL),
 * but at every capture site the injected record is in scope — so its values
 * are replaced verbatim. Two carve-outs keep diagnostics useful: values under
 * 8 chars (a port, a flag — too short to be a credential, too common to
 * scrub), and credential-free http(s) URLs (a `BASE_URL` is how a gate names
 * the preview it failed against; a URL carrying userinfo is still scrubbed).
 */
export function redactEnvValues(
  text: string,
  env: Record<string, string> | undefined,
): string {
  if (!env || !text) return text;
  const values = Object.values(env)
    .filter((v) => v.length >= 8)
    .filter((v) => !(/^https?:\/\//i.test(v) && !v.includes('@')))
    // Longest first, so a value that contains another is scrubbed whole
    // rather than leaving its tail behind.
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join('[redacted]');
  return out;
}
