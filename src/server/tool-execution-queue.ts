/** Per-dispatch tool scheduling. Reads can overlap; a mutation is exclusive.
 * FIFO prevents new reads from indefinitely delaying an already queued effect.
 * Durable ordering and permission still belong to the runtime/host, not here. */
export function createToolExecutionQueue(readConcurrency: number) {
  let active = 0;
  let writing = false;
  const pending = new Set<Promise<unknown>>();
  const queue: { read: boolean; start: () => void }[] = [];
  function drainQueue() {
    if (writing) return;
    while (queue.length && active < readConcurrency) {
      const next = queue[0]!;
      if (!next.read && active) return;
      queue.shift();
      active++;
      writing = !next.read;
      next.start();
      if (writing) return;
    }
  }
  return {
    run<T>(read: boolean, run: () => Promise<T>): Promise<T> {
      const result = new Promise<T>((resolve, reject) => {
        queue.push({ read, start() {
          Promise.resolve().then(run).then(resolve, reject).finally(() => {
            active--;
            if (!read) writing = false;
            drainQueue();
          });
        } });
        drainQueue();
      });
      pending.add(result);
      void result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    },
    async drain() { await Promise.allSettled([...pending]); },
  };
}
