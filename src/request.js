// Shared cancellation and timeout handling for public REST requests.
export const DEFAULT_REST_TIMEOUT_MS = 15_000;
// Preserve an upstream Retry-After instruction on HTTP errors so callers do not
// hammer a rate-limited or temporarily unavailable exchange.
export function createHttpError(response, { now = Date.now(), maxRetryAfterMs = 24 * 60 * 60 * 1000 } = {}) {
  const error = new Error('HTTP ' + response.status);
  const header = response.headers?.get?.('retry-after');
  if (typeof header === 'string' && header.trim()) {
    const value = header.trim();
    const isDelaySeconds = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
    const seconds = isDelaySeconds ? Number(value) : null;
    const date = isDelaySeconds ? NaN : Date.parse(value);
    const delay = isDelaySeconds ? seconds * 1000 : date - now;
    if (Number.isFinite(delay) && delay > 0) {
      error.retryAfterMs = Math.min(Math.ceil(delay), maxRetryAfterMs);
    }
  }
  return error;
}

const abortError = () => { const error = new Error('REST request aborted'); error.name = 'AbortError'; return error; };
export function withTimeout(operation, { signal, timeoutMs = DEFAULT_REST_TIMEOUT_MS } = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive safe integer');
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
  const controller = new AbortController();
  let timer;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => { const reason = signal.reason ?? abortError(); controller.abort(reason); reject(reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new Error(`REST request timed out after ${timeoutMs} ms`);
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted])
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!controller.signal.aborted) controller.abort();
    });
}
