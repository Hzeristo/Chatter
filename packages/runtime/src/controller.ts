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
  TurnForkMetadata,
  TurnLineage,
} from "@mas-chat/protocol";

import {
  ForegroundResponseNotCancellableError,
  ForegroundResponseNotResumableError,
  StreamEndedWithoutTerminalError,
} from "./errors.js";
import { buildReplayHistory, latestCompletedTurnId } from "./history.js";
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
    lineage?: TurnLineage,
  ): Promise<SessionMetadata>;
  failTurn(
    sessionId: string,
    turnId: string,
    error: JsonObject,
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
  backgroundFallback?: BackgroundFallbackPolicy;
  fork?: TurnForkMetadata;
  /** `null` starts a new root branch; omitted continues the latest completed turn. */
  parentTurnId?: string | null;
  signal?: AbortSignal;
  sessionId: string;
}

export type BackgroundFallbackPolicy = "never" | "on_unsupported";

interface PreparedTurn {
  stream: AsyncIterable<JsonObject>;
  turnId: string;
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
    const diagnostic = error as Error & {
      eventType?: unknown;
      eventKeys?: unknown;
    };
    return {
      name: error.name,
      message: error.message,
      ...(typeof diagnostic.eventType === "string"
        ? { eventType: diagnostic.eventType }
        : {}),
      ...(Array.isArray(diagnostic.eventKeys)
        ? { eventKeys: diagnostic.eventKeys }
        : {}),
    };
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

function isUnsupportedBackgroundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const status = (error as Error & { status?: unknown }).status;
  return (
    status === 400 &&
    /unsupported\s+parameter\s*:\s*background/i.test(error.message)
  );
}

function turnUsesBackground(records: JournalRecord[], turnId: string): boolean {
  const input = records.find(
    (record) => record.kind === "turn.input" && record.turnId === turnId,
  );
  if (input === undefined || input.kind !== "turn.input") {
    throw new Error(`Turn ${turnId} has no persisted request configuration`);
  }
  return input.configuration.background;
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
    const parentTurnId =
      options.parentTurnId === undefined
        ? latestCompletedTurnId(records)
        : options.parentTurnId;
    const history = buildReplayHistory(records, parentTurnId);
    const lineage: TurnLineage = {
      parentTurnId,
      ...(options.fork === undefined ? {} : { fork: options.fork }),
    };
    const backgroundTurnId = this.#turnId();
    let prepared: PreparedTurn;
    try {
      prepared = await this.prepareTurn(
        options.sessionId,
        history,
        newItems,
        options,
        true,
        lineage,
        backgroundTurnId,
        options.signal,
      );
    } catch (error) {
      if (
        options.backgroundFallback !== "on_unsupported" ||
        !isUnsupportedBackgroundError(error)
      ) {
        throw error;
      }
      prepared = await this.prepareTurn(
        options.sessionId,
        history,
        newItems,
        options,
        false,
        {
          parentTurnId,
          fork: {
            kind: "transport_fallback",
            sourceTurnId: backgroundTurnId,
          },
        },
        this.#turnId(),
        options.signal,
      );
    }

    yield* this.consume(
      options.sessionId,
      prepared.turnId,
      prepared.stream,
      createResponseProjection(),
    );
  }

  async *attach(
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<NormalizedEvent> {
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

    if (!turnUsesBackground(records, metadata.activeTurnId)) {
      throw new ForegroundResponseNotResumableError(sessionId);
    }

    const stream = await this.#transport.resume(
      metadata.responseId,
      metadata.lastSequenceNumber,
      signal,
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

    const records = await this.#store.readJournal(sessionId);
    if (!turnUsesBackground(records, metadata.activeTurnId)) {
      throw new ForegroundResponseNotCancellableError(sessionId);
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

    try {
      for await (const event of stream) {
        const type = event.type;
        if (
          typeof type === "string" &&
          type !== "error" &&
          !type.startsWith("response.")
        ) {
          continue;
        }
        if (type === "error" && event.sequence_number === undefined) {
          const message =
            typeof event.message === "string"
              ? event.message
              : "The response stream emitted an error event";
          const streamError = new Error(`Response stream error: ${message}`);
          streamError.name = "ResponseStreamError";
          throw streamError;
        }
        const result = reduceResponseEvent(projection, event);
        projection = result.state;
        if (result.duplicate) {
          continue;
        }

        const responseId = projection.responseId ?? responseIdFromEvent(event);
        if (responseId === undefined) {
          throw new Error(
            "Response stream emitted an event before response ID was known",
          );
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

        if (event.type === "error") {
          const message =
            typeof event.message === "string"
              ? event.message
              : "The response stream emitted an error event";
          const streamError = new Error(`Response stream error: ${message}`);
          streamError.name = "ResponseStreamError";
          throw streamError;
        }

        for (const normalized of result.normalized) {
          yield normalized;
        }

        if (sawTerminal) {
          return;
        }
      }
    } catch (error) {
      const metadata = await this.#store.loadMetadata(sessionId);
      if (metadata.activeTurnId === turnId) {
        await this.#store.failTurn(sessionId, turnId, errorRecord(error));
      }
      throw error;
    }

    const error = new StreamEndedWithoutTerminalError(
      projection.lastSequenceNumber,
      projection.responseId,
    );
    const metadata = await this.#store.loadMetadata(sessionId);
    if (metadata.activeTurnId === turnId) {
      await this.#store.failTurn(sessionId, turnId, errorRecord(error));
    }
    throw error;
  }

  private async prepareTurn(
    sessionId: string,
    history: ResponseInputItem[],
    newItems: ResponseInputItem[],
    options: StatelessRequestOptions,
    background: boolean,
    lineage: TurnLineage,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<PreparedTurn> {
    const request = buildStatelessResponseRequest(
      history,
      newItems,
      options,
      background,
    );
    await this.#store.beginTurn(
      sessionId,
      turnId,
      nativeItems(newItems),
      snapshotRunConfiguration(request),
      lineage,
    );

    try {
      return {
        stream: await this.#transport.create(request, signal),
        turnId,
      };
    } catch (error) {
      const metadata = await this.#store.loadMetadata(sessionId);
      if (metadata.activeTurnId === turnId) {
        await this.#store.abortTurn(sessionId, turnId, errorRecord(error));
      }
      throw error;
    }
  }
}

export type { ResponseCreateParamsStreaming };
