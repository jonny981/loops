export function dedupe(arr) {
  return [...new Set(arr)].sort();
}
