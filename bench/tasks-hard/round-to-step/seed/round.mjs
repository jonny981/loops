// Round x to the nearest multiple of step.
export function roundToStep(x, step) {
  return Math.round(x / step) * step;
}
