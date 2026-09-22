export class InvalidSessionIdError extends Error {
  constructor(id: string) {
    super(`Invalid session identifier: ${JSON.stringify(id)}`);
    this.name = "InvalidSessionIdError";
  }
}

export class SessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStateError";
  }
}

export class JournalCorruptionError extends Error {
  constructor(lineNumber: number, cause: unknown) {
    super(`Invalid JSONL journal record at line ${lineNumber}`, { cause });
    this.name = "JournalCorruptionError";
  }
}
