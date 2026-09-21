import { randomUUID } from "node:crypto";

import type {
  ResponseCreateParamsStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";

import type {
  JournalRecord,
  JsonObject,
  JsonValue,
  NormalizedEvent,
  OpenAINativeItem,
  RunConfigurationSnapshot,
  SessionMetadata,
  TerminalStatus,
} from "@mas-chat/protocol";

import { StreamEndedWithoutTerminalError } from "./errors.js";
import { buildReplayHistory } from "./history.js";
import {
  createResponseProjection,
  reduceResponseEvent,
} from "./reducer.js";
import {
  buildStatelessResponseRequest,
  snapshotRunConfiguration,
  type StatelessRequestOptions,
} from "./request.js";
import type { ResponsesTransport } from "./transport.js";

export interface RunStore {
  abortTurn(
    sessionId: string,
    turnId: string,
    error: JsonObject,
  ): Promise<SessionMetadata>;
  beginTurn(
    sessionId: string,
    turnId: string,
    items: OpenAINativeItem[],
    configuration: RunConfigurationSnapshot,
  ): Promise<SessionMetadata>;
  loadMetadata(sessionId: string): Promise<SessionMetadata>;
  readJournal(sessionId: string): Promise<JournalRecord[]>;
  recordResponseEvent(
    sessionId: string,
    turnId: string,
    responseId: string,
    event: JsonObject,
  ): Promise<unknown>;
  recordTurnOutput(
    sessionId: string,
    turnId: string,
    responseId: string,
    status: TerminalStatus,
    items: OpenAINativeItem[],
    response?: JsonObject,
  ): Promise<SessionMetadata>;
}

export interface StartRunOptions extends StatelessRequestOptions {
  sessionId: string;
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function responseIdFromEvent(event: JsonObject): string | undefined {
  if (typeof event.response_id === "string") {
    return event.response_id;
  }
  const response = objectValue(event.response);
  return typeof response?.id === "string" ? response.id : undefined;
}

function responseOutputFromEvent(event: JsonObject): OpenAINativeItem[] {
  const response = objectValue(event.response);
  const output = response?.output;
  if (!Array.isArray(output)) {
    return [];
  }
  return output.filter(
    (item): item is OpenAINativeItem =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function responseOutput(response: JsonObject): OpenAINativeItem[] {
  const output = response.output;
  if (!Array.isArray(output)) {
    return [];
  }
  return output.filter(
    (item): item is OpenAINativeItem =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function errorRecord(error: unknown): JsonObject {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}

function isTerminalStatus(value: string): value is TerminalStatus {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "incomplete" ||
    value === "cancelled"
  );
}

function nativeItems(items: ResponseInputItem[]): OpenAINativeItem[] {
  return items as unknown as OpenAINativeItem[];
}

export class RunController {
  readonly #store: RunStore;
  readonly #transport: ResponsesTransport;
  readonly #turnId: () => string;

  constructor(
    store: RunStore,
    transport: ResponsesTransport,
    turnId: () => string = () => randomUUID(),
  ) {
    this.#store = store;
    this.#transport = transport;
    this.#turnId = turnId;
  }

  async *start(
    newItems: ResponseInputItem[],
    options: StartRunOptions,
  ): AsyncGenerator<NormalizedEvent> {
    const records = await this.#store.readJournal(options.sessionId);
    const history = buildReplayHistory(records);
    const request = buildStatelessResponseRequest(history, newItems, options);
    const turnId = this.#turnId();
    await this.#store.beginTurn(
      options.sessionId,
      turnId,
      nativeItems(newItems),
      snapshotRunConfiguration(request),
    );

    let stream: AsyncIterable<JsonObject>;
    try {
      stream = await this.#transport.create(request);
    } catch (error) {
      await this.#store.abortTurn(
        options.sessionId,
        turnId,
        errorRecord(error),
      );
      throw error;
    }

    yield* this.consume(
      options.sessionId,
      turnId,
      stream,
      createResponseProjection(),
    );
  }

  async *attach(sessionId: string): AsyncGenerator<NormalizedEvent> {
    const metadata = await this.#store.loadMetadata(sessionId);
    if (metadata.activeTurnId === undefined || metadata.responseId === undefined) {
      throw new Error(`Session ${sessionId} has no resumable response`);
    }

    const records = await this.#store.readJournal(sessionId);
    let projection = createResponseProjection();
    let terminalEvent: JsonObject | undefined;
    for (const record of records) {
      if (
        record.kind === "response.event" &&
        record.turnId === metadata.activeTurnId
      ) {
        projection = reduceResponseEvent(projection, record.event).state;
        if (isTerminalStatus(projection.status)) {
          terminalEvent = record.event;
        }
      }
    }

    if (terminalEvent !== undefined && isTerminalStatus(projection.status)) {
      await this.#store.recordTurnOutput(
        sessionId,
        metadata.activeTurnId,
        metadata.responseId,
        projection.status,
        responseOutputFromEvent(terminalEvent),
        objectValue(terminalEvent.response),
      );
      return;
    }

    const stream = await this.#transport.resume(
      metadata.responseId,
      metadata.lastSequenceNumber,
    );
    yield* this.consume(
      sessionId,
      metadata.activeTurnId,
      stream,
      projection,
    );
  }

  async cancel(sessionId: string): Promise<NormalizedEvent> {
    const metadata = await this.#store.loadMetadata(sessionId);
    if (metadata.activeTurnId === undefined || metadata.responseId === undefined) {
      throw new Error(`Session ${sessionId} has no cancellable response`);
    }

    const response = await this.#transport.cancel(metadata.responseId);
    const rawStatus = response.status;
    if (typeof rawStatus !== "string" || !isTerminalStatus(rawStatus)) {
      throw new Error(
        `Cancel did not return a terminal response: ${String(rawStatus)}`,
      );
    }

    await this.#store.recordTurnOutput(
      sessionId,
      metadata.activeTurnId,
      metadata.responseId,
      rawStatus,
      responseOutput(response),
      response,
    );

    const usage = objectValue(response.usage);
    return {
      kind: "terminal",
      sourceType: "response.cancel",
      responseId: metadata.responseId,
      sequenceNumber: metadata.lastSequenceNumber,
      status: rawStatus,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  private async *consume(
    sessionId: string,
    turnId: string,
    stream: AsyncIterable<JsonObject>,
    initialProjection: ReturnType<typeof createResponseProjection>,
  ): AsyncGenerator<NormalizedEvent> {
    let projection = initialProjection;
    let sawTerminal = false;

    for await (const event of stream) {
      const result = reduceResponseEvent(projection, event);
      projection = result.state;
      if (result.duplicate) {
        continue;
      }

      const responseId = projection.responseId ?? responseIdFromEvent(event);
      if (responseId === undefined) {
        throw new Error("Response stream emitted an event before response ID was known");
      }

      await this.#store.recordResponseEvent(
        sessionId,
        turnId,
        responseId,
        event,
      );

      if (isTerminalStatus(projection.status)) {
        const response = objectValue(event.response);
        await this.#store.recordTurnOutput(
          sessionId,
          turnId,
          responseId,
          projection.status,
          responseOutputFromEvent(event),
          response,
        );
        sawTerminal = true;
      }

      for (const normalized of result.normalized) {
        yield normalized;
      }

      if (sawTerminal) {
        return;
      }
    }

    throw new StreamEndedWithoutTerminalError(
      projection.lastSequenceNumber,
      projection.responseId,
    );
  }
}

export type { ResponseCreateParamsStreaming };
