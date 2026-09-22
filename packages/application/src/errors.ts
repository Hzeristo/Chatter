export class SessionRunOwnedError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} already has a run owned by this service`);
    this.name = "SessionRunOwnedError";
  }
}

export class SessionCommandConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCommandConflictError";
  }
}
