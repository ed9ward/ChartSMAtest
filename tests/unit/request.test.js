import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout, createHttpError } from '../../src/request.js';
afterEach(() => vi.useRealTimers());
describe('withTimeout', () => {
  it('times out and aborts the request signal', async () => {
    vi.useFakeTimers();
    let requestSignal;
    const pending = withTimeout((signal) => { requestSignal = signal; return new Promise(() => {}); }, { timeoutMs: 25 });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError', message: 'REST request timed out after 25 ms' });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(requestSignal.aborted).toBe(true);
  });
  it('propagates caller cancellation as AbortError', async () => {
    const parent = new AbortController();
    const pending = withTimeout((signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { signal: parent.signal, timeoutMs: 1000 });
    parent.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not start when the parent signal is already aborted', async () => {
    const parent = new AbortController(); parent.abort();
    const operation = vi.fn();
    await expect(withTimeout(operation, { signal: parent.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).not.toHaveBeenCalled();
  });
});


describe('createHttpError', () => {
  const response = (status, retryAfter) => ({
    status,
    headers: { get: (name) => name === 'retry-after' ? retryAfter : null },
  });

  it('parses Retry-After as delay-seconds', () => {
    expect(createHttpError(response(429, '5'), { now: 0 }).retryAfterMs).toBe(5000);
    expect(createHttpError(response(418, '0.25'), { now: 0 }).retryAfterMs).toBe(250);
  });

  it('parses Retry-After as an HTTP date', () => {
    expect(createHttpError(response(503, 'Thu, 01 Jan 1970 00:00:05 GMT'), { now: 1000 }).retryAfterMs).toBe(4000);
  });

  it.each([null, '', 'tomorrow', '-5', 'NaN', '0'])('ignores absent, invalid, or expired Retry-After: %s', (header) => {
    expect(createHttpError(response(429, header), { now: 0 }).retryAfterMs).toBeUndefined();
  });

  it('caps unreasonable server delays at 24 hours', () => {
    expect(createHttpError(response(429, '999999'), { now: 0 }).retryAfterMs).toBe(86_400_000);
  });

  it('preserves the HTTP status message', () => {
    expect(createHttpError(response(429, null)).message).toBe('HTTP 429');
  });
});
