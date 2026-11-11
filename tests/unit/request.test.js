import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from '../../src/request.js';
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
