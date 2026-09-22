import { SessionRunOwnedError } from "./errors.js";

export interface RunHandle {
  signal: AbortSignal;
  release(): void;
}

export class RunRegistry {
  readonly #sessions = new Map<string, AbortController>();

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  claim(sessionId: string): RunHandle {
    if (this.#sessions.has(sessionId)) {
      throw new SessionRunOwnedError(sessionId);
    }
    const controller = new AbortController();
    this.#sessions.set(sessionId, controller);
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (!released) {
          released = true;
          if (this.#sessions.get(sessionId) === controller) {
            this.#sessions.delete(sessionId);
          }
        }
      },
    };
  }

  abort(sessionId: string): void {
    this.#sessions.get(sessionId)?.abort();
  }
}
