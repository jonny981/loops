// Compare two dotted version strings. Returns -1, 0, or 1.
export function compareVersions(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
