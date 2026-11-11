// The contract of the `limit` argument of the history requests (shared by every data source).
export function assertLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`limit must be a non-negative integer, got ${limit}`);
}
