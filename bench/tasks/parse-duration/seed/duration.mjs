// Multiplier in milliseconds for each duration unit.
const UNIT = { h: 3600000, m: 1000, s: 1000 };

export function parseDuration(str) {
  let ms = 0;
  for (const [, n, u] of str.matchAll(/(\d+)([hms])/g)) {
    ms += Number(n) * UNIT[u];
  }
  return ms;
}
