/** PDF.js 5.4.624 shares its page mapper across documents in a process. */
type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};
const waiters: Waiter[] = [];
let held = false;
function advance() {
  if (held) return;
  const waiter = waiters.shift();
  if (!waiter) return;
  waiter.signal?.removeEventListener("abort", waiter.onAbort!);
  held = true;
  let released = false;
  waiter.resolve(() => {
    if (!released) {
      released = true;
      held = false;
      advance();
    }
  });
}
export function acquirePdfDocument(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
    if (signal) {
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    waiters.push(waiter);
    advance();
  });
}
