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

export class SequenceGapError extends Error {
  readonly expected: number;
  readonly received: number;

  constructor(expected: number, received: number) {
    super(`Response event sequence gap: expected ${expected}, received ${received}`);
    this.name = "SequenceGapError";
    this.expected = expected;
    this.received = received;
  }
}

export class JournalCorruptionError extends Error {
  constructor(lineNumber: number, cause: unknown) {
    super(`Invalid JSONL journal record at line ${lineNumber}`, { cause });
    this.name = "JournalCorruptionError";
  }
}
