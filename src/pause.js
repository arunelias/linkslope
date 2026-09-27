/**
 * Create an in-memory cooperative pause gate; active requests are not interrupted.
 * Call wait before starting new work and inspect the abort signal after it resolves.
 * @returns {{readonly paused: boolean, pause: () => void, resume: () => void, wait: (signal: AbortSignal) => Promise<void>}}
 */
export function createPauseControl() {
  let paused = false;
  const events = new EventTarget();
  return {
    get paused() { return paused; },
    pause() { paused = true; },
    resume() {
      paused = false;
      events.dispatchEvent(new Event('resume'));
    },
    async wait(signal) {
      while (paused && !signal.aborted) {
        await new Promise(resolve => {
          const finish = () => {
            events.removeEventListener('resume', finish);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          events.addEventListener('resume', finish, { once: true });
          signal.addEventListener('abort', finish, { once: true });
        });
      }
    },
  };
}
