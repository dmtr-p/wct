/** Own mutations independently of Ink so render failures can still drain them. */
export function createTuiLifetime(dispose: () => Promise<void>) {
  const messages: string[] = [];
  const active = new Set<Promise<unknown>>();
  const waitCancellation = new AbortController();
  let closing = false;
  let drain: Promise<void> | undefined;
  let finalization: Promise<void> | undefined;
  return {
    messages,
    waitSignal: waitCancellation.signal,
    report(message: string) {
      messages.push(message);
    },
    get closing() {
      return closing;
    },
    track<T>(run: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new Error("TUI is shutting down"));
      // Register before invoking callbacks, including callbacks that request quit.
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      active.add(promise);
      void promise.then(
        () => active.delete(promise),
        () => active.delete(promise),
      );
      try {
        resolve(run());
      } catch (error) {
        reject(error);
      }
      return promise;
    },
    quit(): Promise<void> {
      closing = true;
      waitCancellation.abort();
      drain ??= Promise.allSettled(active).then(() => undefined);
      return drain;
    },
    finalize(): Promise<void> {
      finalization ??= this.quit().then(dispose);
      return finalization;
    },
  };
}
export type TuiLifetime = ReturnType<typeof createTuiLifetime>;

/** Keep the terminal and runtime boundaries ordered even when rendering fails. */
export async function runTuiInvocation(options: {
  dispose: () => Promise<void>;
  start: (lifetime: TuiLifetime) => TuiInstance | Promise<TuiInstance>;
  report?: (message: string) => void;
  cleanup: () => void;
}): Promise<void> {
  const lifetime = createTuiLifetime(options.dispose);
  let instance: TuiInstance | undefined;
  try {
    instance = await options.start(lifetime);
    await instance.waitUntilExit();
  } finally {
    await lifetime.quit();
    try {
      instance?.unmount();
    } finally {
      try {
        options.cleanup();
      } finally {
        try {
          await lifetime.finalize();
        } finally {
          for (const message of lifetime.messages) options.report?.(message);
        }
      }
    }
  }
}

interface TuiInstance {
  waitUntilExit: () => Promise<unknown>;
  unmount: () => void;
}
