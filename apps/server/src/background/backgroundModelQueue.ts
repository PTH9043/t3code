export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const waiting = Promise.withResolvers<never>();
    const cancel = () => waiting.reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    const next = tail.then(() => {
      signal.removeEventListener("abort", cancel);
      signal.throwIfAborted();
      return task();
    });
    tail = next.then(
      () => {},
      () => {},
    );
    return Promise.race([next, waiting.promise]);
  };
}

// Telegram summaries and background RAG pages share this queue in the server process.
export const runBackgroundModelJob = createSerialQueue();
