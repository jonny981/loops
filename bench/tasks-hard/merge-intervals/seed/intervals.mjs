// Merge overlapping intervals. Each interval is [start, end].
export function mergeIntervals(intervals) {
  const out = [];
  for (const [s, e] of intervals) {
    const last = out[out.length - 1];
    if (last && s < last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}
