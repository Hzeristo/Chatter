export class ResponseSequenceError extends Error {
  readonly expected: number;
  readonly received: number;

  constructor(expected: number, received: number) {
    super(`Response event sequence gap: expected ${expected}, received ${received}`);
    this.name = "ResponseSequenceError";
    this.expected = expected;
    this.received = received;
  }
}

export class ResponseIdentityError extends Error {
  constructor(expected: string, received: string) {
    super(`Response ID mismatch: expected ${expected}, received ${received}`);
    this.name = "ResponseIdentityError";
  }
}

export class ReplayHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayHistoryError";
  }
}

export class StreamEndedWithoutTerminalError extends Error {
  readonly lastSequenceNumber: number;
  readonly responseId?: string;

  constructor(lastSequenceNumber: number, responseId?: string) {
    super(
      `Response stream ended without a terminal event after sequence ${lastSequenceNumber}`,
    );
    this.name = "StreamEndedWithoutTerminalError";
    this.lastSequenceNumber = lastSequenceNumber;
    if (responseId !== undefined) {
      this.responseId = responseId;
    }
  }
}
