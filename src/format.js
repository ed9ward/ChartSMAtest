// How many decimals to show for numbers of a given size.

/**
 * Decimals for a price or indicator line, from the typical size of its values (the median, so one outlier does not matter).
 * Two decimals for anything from 1 up (BTC 73488.01, ETH 3512.40, SOL 148.77); more for small numbers so that something
 * like 0.00001234 is not shown as 0.00: three digits after the leading zeros, up to 12 decimals.
 */
export function priceDecimals(values) {
  const sizes = values.filter((v) => Number.isFinite(v) && v !== 0).map(Math.abs).sort((a, b) => a - b);
  if (sizes.length === 0) return 2;
  const median = sizes[Math.floor(sizes.length / 2)];
  if (median >= 1) return 2;
  return Math.min(12, Math.max(2, Math.ceil(-Math.log10(median)) + 3));
}

export const formatFixed = (n, decimals) => (Number.isFinite(n) ? n.toFixed(decimals) : '—');
