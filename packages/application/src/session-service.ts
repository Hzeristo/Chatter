import { randomUUID } from "node:crypto";

import type { ResponseInputItem } from "openai/resources/responses/responses";

import type { RunPolicy } from "@mas-chat/config";
import type { JsonObject, NormalizedEvent, SessionMetadata } from "@mas-chat/protocol";
import { resolveTurns, type RunController } from "@mas-chat/runtime";
import {
  SessionStore,
  type StoredSessionSnapshot,
} from "@mas-chat/storage";

import { SessionCommandConflictError } from "./errors.js";
import { RunRegistry } from "./run-registry.js";

export interface SessionSnapshot extends StoredSessionSnapshot {
  locallyActive: boolean;
}

export interface ContinueOptions {
  parentTurnId?: string | null;
}

function promptInput(prompt: string): ResponseInputItem[] {
  return [{ role: "user", content: prompt }] as ResponseInputItem[];
}

function errorRecord(error: unknown): JsonObject {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: String(error) };
  }
  const details = error as Error & { status?: unknown; code?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof details.status === "number" ? { status: details.status } : {}),
    ...(typeof details.code === "string" ? { code: details.code } : {}),
  };
}

export class SessionService {
  readonly #controller: () => RunController;
  readonly #ids: () => string;
  readonly #registry: RunRegistry;
  readonly #runPolicy: RunPolicy;
  readonly #store: SessionStore;

  constructor(
    store: SessionStore,
    controller: () => RunController,
    runPolicy: RunPolicy,
    registry = new RunRegistry(),
    ids: () => string = () => randomUUID(),
  ) {
    this.#store = store;
    this.#controller = controller;
    this.#runPolicy = runPolicy;
    this.#registry = registry;
    this.#ids = ids;
  }

  async createSession(): Promise<string> {
    const sessionId = this.#ids();
    await this.#store.createSession(sessionId);
    return sessionId;
  }

  async inspectSession(sessionId: string): Promise<SessionSnapshot> {
    const snapshot = await this.#store.inspectSession(sessionId);
    return {
      ...snapshot,
      locallyActive: this.#registry.has(sessionId),
    };
  }

  async listSessions(): Promise<SessionSnapshot[]> {
    const snapshots = await this.#store.listSessionSnapshots();
    return snapshots.map((snapshot) => ({
      ...snapshot,
      locallyActive: this.#registry.has(snapshot.metadata.sessionId),
    }));
  }

  async archiveSession(sessionId: string): Promise<SessionMetadata> {
    const snapshot = await this.#store.inspectSession(sessionId);
    if (this.#registry.has(sessionId) || snapshot.metadata.activeTurnId !== undefined) {
      throw new SessionCommandConflictError(`Session ${sessionId} is still running and cannot be archived`);
    }
    return this.#store.archiveSession(sessionId);
  }

  async reconcileInterruptedSessions(): Promise<void> {
    for (const snapshot of await this.#store.listSessionSnapshots()) {
      const activeTurnId = snapshot.metadata.activeTurnId;
      if (activeTurnId === undefined || this.#registry.has(snapshot.metadata.sessionId)) {
        continue;
      }
      const active = resolveTurns(snapshot.records).find(
        (turn) => turn.input.turnId === activeTurnId,
      );
      if (active === undefined) {
        throw new SessionCommandConflictError(
          `Session ${snapshot.metadata.sessionId} has no input for active turn ${activeTurnId}`,
        );
      }
      if (
        active.input.configuration.background &&
        snapshot.metadata.responseId !== undefined
      ) {
        continue;
      }
      await this.#store.failTurn(snapshot.metadata.sessionId, activeTurnId, {
        name: active.input.configuration.background
          ? "ResponseIdUnavailable"
          : "ForegroundRunOwnerLost",
        message: active.input.configuration.background
          ? "The interrupted background response has no persisted response ID"
          : "The foreground response lost its owning service process",
      });
    }
  }

  async continueSession(
    sessionId: string,
    prompt: string,
    options: ContinueOptions = {},
  ): Promise<AsyncIterable<NormalizedEvent>> {
    return this.#ownedStream(sessionId, async (signal) => {
      const snapshot = await this.#store.inspectSession(sessionId);
      if (snapshot.metadata.activeTurnId !== undefined) {
        if (options.parentTurnId !== snapshot.metadata.activeTurnId) {
          throw new SessionCommandConflictError(
            `Session ${sessionId} has a different active turn than the selected parent`,
          );
        }
        await this.#supersedeActiveTurn(snapshot, "continuation");
      }
      return this.#controller().start(promptInput(prompt), {
        sessionId,
        ...this.#runPolicy,
        signal,
        ...(options.parentTurnId === undefined
          ? {}
          : { parentTurnId: options.parentTurnId }),
      });
    });
  }

  async retryTurn(
    sessionId: string,
    sourceTurnId: string,
  ): Promise<AsyncIterable<NormalizedEvent>> {
    return this.#branchTurn(sessionId, sourceTurnId, "retry");
  }

  async editTurn(
    sessionId: string,
    sourceTurnId: string,
    prompt: string,
  ): Promise<AsyncIterable<NormalizedEvent>> {
    return this.#branchTurn(sessionId, sourceTurnId, "edit", prompt);
  }

  async forkTurn(
    sessionId: string,
    sourceTurnId: string,
    prompt: string,
  ): Promise<AsyncIterable<NormalizedEvent>> {
    return this.#ownedStream(sessionId, async (signal) => {
      const snapshot = await this.#store.inspectSession(sessionId);
      if (snapshot.metadata.activeTurnId !== undefined) {
        throw new SessionCommandConflictError(
          `Session ${sessionId} has an active turn and cannot fork`,
        );
      }
      const source = resolveTurns(snapshot.records).find(
        (turn) => turn.input.turnId === sourceTurnId,
      );
      if (source === undefined) {
        throw new SessionCommandConflictError(`Unknown turn ${sourceTurnId}`);
      }
      return this.#controller().start(promptInput(prompt), {
        sessionId,
        ...this.#runPolicy,
        signal,
        parentTurnId: sourceTurnId,
        fork: { kind: "explicit", sourceTurnId },
      });
    });
  }

  async attach(sessionId: string): Promise<AsyncIterable<NormalizedEvent>> {
    return this.#ownedStream(sessionId, (signal) =>
      this.#attachWithFailureHandling(sessionId, signal),
    );
  }

  cancel(sessionId: string): Promise<NormalizedEvent> {
    return this.#stopActiveTurn(sessionId);
  }

  async #branchTurn(
    sessionId: string,
    sourceTurnId: string,
    kind: "edit" | "retry",
    editedPrompt?: string,
  ): Promise<AsyncIterable<NormalizedEvent>> {
    return this.#ownedStream(sessionId, async (signal) => {
      let snapshot = await this.#store.inspectSession(sessionId);
      let source = resolveTurns(snapshot.records).find(
        (turn) => turn.input.turnId === sourceTurnId,
      );
      if (source === undefined) {
        throw new SessionCommandConflictError(`Unknown turn ${sourceTurnId}`);
      }
      if (snapshot.metadata.activeTurnId !== undefined) {
        if (snapshot.metadata.activeTurnId !== sourceTurnId) {
          throw new SessionCommandConflictError(
            `Session ${sessionId} has a different active turn`,
          );
        }
        await this.#supersedeActiveTurn(snapshot, kind);
        snapshot = await this.#store.inspectSession(sessionId);
        source = resolveTurns(snapshot.records).find(
          (turn) => turn.input.turnId === sourceTurnId,
        );
        if (source === undefined) {
          throw new SessionCommandConflictError(`Unknown turn ${sourceTurnId}`);
        }
      }

      const input =
        editedPrompt === undefined
          ? (source.input.items as unknown as ResponseInputItem[])
          : promptInput(editedPrompt);
      return this.#controller().start(input, {
        sessionId,
        ...this.#runPolicy,
        signal,
        parentTurnId: source.parentTurnId,
        fork: { kind, sourceTurnId },
      });
    });
  }

  async *#attachWithFailureHandling(
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<NormalizedEvent> {
    try {
      yield* this.#controller().attach(sessionId, signal);
    } catch (error) {
      const snapshot = await this.#store.inspectSession(sessionId);
      const activeTurnId = snapshot.metadata.activeTurnId;
      if (activeTurnId !== undefined) {
        await this.#store.failTurn(sessionId, activeTurnId, {
          name: "RemoteResponseError",
          message: "The remote response cannot be attached",
          cause: errorRecord(error),
        });
      }
      throw error;
    }
  }

  async #stopActiveTurn(sessionId: string): Promise<NormalizedEvent> {
    const snapshot = await this.#store.inspectSession(sessionId);
    const activeTurnId = snapshot.metadata.activeTurnId;
    if (activeTurnId === undefined) {
      throw new SessionCommandConflictError(
        `Session ${sessionId} has no active turn to stop`,
      );
    }

    if (snapshot.metadata.responseId !== undefined) {
      try {
        const terminal = await this.#controller().cancel(sessionId);
        this.#registry.abort(sessionId);
        return terminal;
      } catch (error) {
        await this.#failStoppedTurn(snapshot, activeTurnId, error);
        this.#registry.abort(sessionId);
        return {
          kind: "terminal",
          sourceType: "user.stop",
          sequenceNumber: snapshot.metadata.lastSequenceNumber,
          status: "failed",
        };
      }
    }

    await this.#failStoppedTurn(snapshot, activeTurnId);
    this.#registry.abort(sessionId);
    return {
      kind: "terminal",
      sourceType: "user.stop",
      sequenceNumber: snapshot.metadata.lastSequenceNumber,
      status: "failed",
    };
  }

  async #failStoppedTurn(
    snapshot: StoredSessionSnapshot,
    activeTurnId: string,
    cause?: unknown,
  ): Promise<void> {
    const current = await this.#store.loadMetadata(snapshot.metadata.sessionId);
    if (current.activeTurnId !== activeTurnId) {
      return;
    }
    await this.#store.failTurn(snapshot.metadata.sessionId, activeTurnId, {
      name: "TurnStoppedByUser",
      message: "The active response was stopped by the user",
      ...(cause === undefined ? {} : { cause: errorRecord(cause) }),
    });
  }

  async #supersedeActiveTurn(
    snapshot: StoredSessionSnapshot,
    reason: "continuation" | "edit" | "retry",
  ): Promise<void> {
    const activeTurnId = snapshot.metadata.activeTurnId;
    if (activeTurnId === undefined) {
      return;
    }
    const active = resolveTurns(snapshot.records).find(
      (turn) => turn.input.turnId === activeTurnId,
    );
    if (active === undefined) {
      throw new SessionCommandConflictError(
        `Session ${snapshot.metadata.sessionId} has no input for active turn ${activeTurnId}`,
      );
    }
    if (
      active.input.configuration.background &&
      snapshot.metadata.responseId !== undefined
    ) {
      await this.#controller().cancel(snapshot.metadata.sessionId);
      return;
    }
    await this.#store.failTurn(snapshot.metadata.sessionId, activeTurnId, {
      name: "TurnSuperseded",
      message: `The unfinished response was superseded by user ${reason}`,
    });
  }

  async #ownedStream(
    sessionId: string,
    create: (signal: AbortSignal) =>
      | AsyncIterable<NormalizedEvent>
      | Promise<AsyncIterable<NormalizedEvent>>,
  ): Promise<AsyncIterable<NormalizedEvent>> {
    const handle = this.#registry.claim(sessionId);
    try {
      const events = await create(handle.signal);
      return this.#releaseAfter(events, handle.release);
    } catch (error) {
      handle.release();
      throw error;
    }
  }

  async *#releaseAfter(
    events: AsyncIterable<NormalizedEvent>,
    release: () => void,
  ): AsyncGenerator<NormalizedEvent> {
    try {
      yield* events;
    } finally {
      release();
    }
  }
}
