export class ResponseSequenceError extends Error {
  readonly expected: number;
  readonly received: number | undefined;
  readonly eventType?: string;
  readonly eventKeys?: string[];

  constructor(
    expected: number,
    received: number | undefined,
    details?: { eventType?: string; eventKeys?: string[] },
  ) {
    const reason =
      received === undefined
        ? "missing sequence_number"
        : received < 0
          ? "invalid sequence_number"
          : "sequence gap";
    super(
      received === undefined
        ? `Response event ${reason}: expected ${expected}`
        : `Response event ${reason}: expected ${expected}, received ${received}`,
    );
    this.name = "ResponseSequenceError";
    this.expected = expected;
    this.received = received;
    if (details?.eventType !== undefined) this.eventType = details.eventType;
    if (details?.eventKeys !== undefined) this.eventKeys = details.eventKeys;
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

export class ForegroundResponseNotResumableError extends Error {
  constructor(sessionId: string) {
    super(
      `Session ${sessionId} is using foreground fallback and cannot be resumed after disconnect`,
    );
    this.name = "ForegroundResponseNotResumableError";
  }
}

export class ForegroundResponseNotCancellableError extends Error {
  constructor(sessionId: string) {
    super(
      `Session ${sessionId} is using foreground fallback; cancel it by terminating the active client connection`,
    );
    this.name = "ForegroundResponseNotCancellableError";
  }
}
