// Numerically scaled population statistics for finite JavaScript numbers.
// Scaling before summation/squaring avoids intermediate overflow and underflow.
export function mean(values) {
  if (values.length === 0) return NaN;
  let scale = 0;
  for (const value of values) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) return 0;
  let normalized = 0;
  for (const value of values) normalized += value / scale;
  return (normalized / values.length) * scale;
}

export function populationStdDev(values) {
  if (values.length === 0) return NaN;
  let scale = 0;
  for (const value of values) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) return 0;
  let normalizedMean = 0;
  for (const value of values) normalizedMean += value / scale;
  normalizedMean /= values.length;
  let squared = 0;
  for (const value of values) {
    const delta = value / scale - normalizedMean;
    squared += delta * delta;
  }
  return scale * Math.sqrt(squared / values.length);
}
