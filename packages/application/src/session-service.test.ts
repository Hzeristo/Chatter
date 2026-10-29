import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";

import type { JsonObject, RunConfigurationSnapshot } from "@mas-chat/protocol";
import {
  RunController,
  type ResponsesTransport,
} from "@mas-chat/runtime";
import { SessionStore } from "@mas-chat/storage";

import { SessionRunOwnedError } from "./errors.js";
import { acquireDataDirectoryLease } from "./lease.js";
import { SessionService } from "./session-service.js";

const temporaryDirectories: string[] = [];

async function temporaryStore(): Promise<SessionStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "mas-chat-application-"));
  temporaryDirectories.push(directory);
  return new SessionStore(directory);
}

async function* eventStream(events: JsonObject[]): AsyncGenerator<JsonObject> {
  yield* events;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

class CompletingTransport implements ResponsesTransport {
  count = 0;
  readonly requests: ResponseCreateParamsStreaming[] = [];
  cancelError: Error | undefined;
  readonly resumeError: Error | undefined;

  constructor(resumeError?: Error) {
    this.resumeError = resumeError;
  }

  async create(
    request: ResponseCreateParamsStreaming,
  ): Promise<AsyncIterable<JsonObject>> {
    this.requests.push(structuredClone(request));
    this.count += 1;
    const responseId = `response-${this.count}`;
    return eventStream([
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: responseId, status: "queued", output: [] },
      },
      {
        type: "response.completed",
        sequence_number: 1,
        response: {
          id: responseId,
          status: "completed",
          output: [
            {
              id: `message-${this.count}`,
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: `answer-${this.count}` }],
            },
          ],
        },
      },
    ]);
  }

  async cancel(responseId: string): Promise<JsonObject> {
    if (this.cancelError !== undefined) {
      throw this.cancelError;
    }
    return { id: responseId, status: "cancelled", output: [] };
  }

  async resume(): Promise<AsyncIterable<JsonObject>> {
    if (this.resumeError !== undefined) {
      throw this.resumeError;
    }
    return eventStream([]);
  }
}

class BlockingTransport implements ResponsesTransport {
  readonly createStarted: Promise<void>;
  readonly #resolveCreateStarted: () => void;
  signal: AbortSignal | undefined;
  cancelCalls = 0;

  constructor(readonly emitResponseId: boolean) {
    let resolveCreateStarted!: () => void;
    this.createStarted = new Promise((resolve) => {
      resolveCreateStarted = resolve;
    });
    this.#resolveCreateStarted = resolveCreateStarted;
  }

  async create(
    _request: ResponseCreateParamsStreaming,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<JsonObject>> {
    this.signal = signal;
    this.#resolveCreateStarted();
    const responseId = "response-blocking";
    const emitResponseId = this.emitResponseId;
    return (async function* (): AsyncGenerator<JsonObject> {
      if (emitResponseId) {
        yield {
          type: "response.created",
          sequence_number: 0,
          response: { id: responseId, status: "in_progress", output: [] },
        };
      }
      await waitForAbort(signal!);
    })();
  }

  async cancel(responseId: string): Promise<JsonObject> {
    this.cancelCalls += 1;
    return { id: responseId, status: "cancelled", output: [] };
  }

  async resume(
    _responseId: string,
    _startingAfter: number,
    _signal?: AbortSignal,
  ): Promise<AsyncIterable<JsonObject>> {
    return eventStream([]);
  }
}

async function consume(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Consuming the stream is the observable application operation.
  }
}

function createService(
  store: SessionStore,
  turnIds: string[],
  resumeError?: Error,
): SessionService {
  const controller = new RunController(
    store,
    new CompletingTransport(resumeError),
    () => turnIds.shift()!,
  );
  return new SessionService(store, () => controller, {});
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SessionService", () => {
  it.each(["retry", "edit"] as const)(
    "keeps repeated root %s requests free of sibling answers",
    async (kind) => {
      const store = await temporaryStore();
      await store.createSession("session-1");
      const transport = new CompletingTransport();
      const turnIds = ["root", "replacement", "retry-again", "next"];
      const controller = new RunController(store, transport, () => turnIds.shift()!);
      const service = new SessionService(store, () => controller, {});
      const prompt = kind === "edit" ? "Edited root" : "Root";

      await consume(await service.continueSession("session-1", "Root"));
      await consume(kind === "edit"
        ? await service.editTurn("session-1", "root", prompt)
        : await service.retryTurn("session-1", "root"));
      await consume(await service.retryTurn("session-1", "replacement"));

      expect(transport.requests.map((request) => request.input)).toEqual([
        [{ role: "user", content: "Root" }],
        [{ role: "user", content: prompt }],
        [{ role: "user", content: prompt }],
      ]);

      const records = await store.readJournal("session-1");
      const retriedInput = records.filter((record) => record.kind === "turn.input")
        .find((record) => record.turnId === "retry-again")!;
      const retriedOutput = records.filter((record) => record.kind === "turn.output")
        .find((record) => record.turnId === "retry-again")!;
      expect(retriedInput.lineage?.parentTurnId).toBeNull();

      await consume(await service.continueSession("session-1", "Follow-up"));
      expect(transport.requests[3]?.input).toEqual([
        ...retriedInput.items,
        ...retriedOutput.items,
        { role: "user", content: "Follow-up" },
      ]);
    },
  );

  it("keeps inspect and list pure, then reconciles interrupted work explicitly", async () => {
    const store = await temporaryStore();
    await store.createSession("session-1");
    const configuration: RunConfigurationSnapshot = {
      model: "test-model",
      background: false,
      stream: true,
      store: false,
      reasoning: {},
      text: {},
      tools: [],
      include: [],
    };
    await store.beginTurn(
      "session-1",
      "interrupted",
      [{ role: "user", content: "Question" }],
      configuration,
    );
    const service = createService(store, []);
    const before = await store.readJournal("session-1");

    expect((await service.inspectSession("session-1")).metadata.activeTurnId).toBe(
      "interrupted",
    );
    expect(await service.listSessions()).toHaveLength(1);
    expect(await store.readJournal("session-1")).toEqual(before);

    await service.reconcileInterruptedSessions();

    expect((await store.readJournal("session-1")).at(-1)).toMatchObject({
      kind: "turn.failed",
      turnId: "interrupted",
      error: { name: "ForegroundRunOwnerLost" },
    });
  });

  it("serializes local ownership before stream consumption", async () => {
    const store = await temporaryStore();
    await store.createSession("session-1");
    const service = createService(store, ["turn-1"]);
    const first = await service.continueSession("session-1", "First");

    await expect(
      service.continueSession("session-1", "Second"),
    ).rejects.toBeInstanceOf(SessionRunOwnedError);

    await consume(first);
    expect((await service.inspectSession("session-1")).locallyActive).toBe(false);
  });

  it.each([
    ["HTTP", Object.assign(new Error("403 forbidden"), { status: 403 })],
    ["transport", new Error("socket closed during attach")],
  ] as const)("turns any %s attach error into a terminal failed turn", async (_kind, error) => {
    const store = await temporaryStore();
    await store.createSession("session-1");
    const configuration: RunConfigurationSnapshot = {
      model: "test-model",
      background: true,
      stream: true,
      store: false,
      reasoning: {},
      text: {},
      tools: [],
      include: [],
    };
    await store.beginTurn(
      "session-1",
      "turn-remote",
      [{ role: "user", content: "Question" }],
      configuration,
    );
    await store.recordResponseEvent("session-1", "turn-remote", "response-remote", {
      type: "response.in_progress",
      sequence_number: 0,
      response_id: "response-remote",
    });
    const service = createService(store, [], error);

    await expect(consume(await service.attach("session-1"))).rejects.toThrow(
      error.message,
    );
    expect((await store.loadMetadata("session-1")).status).toBe("failed");
    expect((await store.loadMetadata("session-1")).activeTurnId).toBeUndefined();
  });

  it("stops locally when remote cancellation fails", async () => {
    const store = await temporaryStore();
    await store.createSession("session-1");
    const configuration: RunConfigurationSnapshot = {
      model: "test-model",
      background: true,
      stream: true,
      store: false,
      reasoning: {},
      text: {},
      tools: [],
      include: [],
    };
    await store.beginTurn(
      "session-1",
      "turn-stop",
      [{ role: "user", content: "Long task" }],
      configuration,
    );
    await store.recordResponseEvent("session-1", "turn-stop", "response-stop", {
      type: "response.in_progress",
      sequence_number: 0,
      response_id: "response-stop",
    });
    const transport = new CompletingTransport();
    transport.cancelError = Object.assign(new Error("500 cancel unavailable"), {
      status: 500,
    });
    const controller = new RunController(store, transport);
    const service = new SessionService(store, () => controller, {});

    const terminal = await service.cancel("session-1");

    expect(terminal).toMatchObject({
      kind: "terminal",
      sourceType: "user.stop",
      status: "failed",
    });
    expect((await store.loadMetadata("session-1")).activeTurnId).toBeUndefined();
    expect((await store.readJournal("session-1")).at(-1)).toMatchObject({
      kind: "turn.failed",
      error: { name: "TurnStoppedByUser" },
    });
  });

  it("propagates stop through the active stream and aborts the SDK request", async () => {
    const store = await temporaryStore();
    await store.createSession("session-1");
    const transport = new BlockingTransport(false);
    const controller = new RunController(store, transport, () => "turn-stop");
    const service = new SessionService(store, () => controller, {});
    expect((await store.readJournal("session-1"))).toHaveLength(1);
    const stream = await service.continueSession("session-1", "Long task");
    const consuming = consume(stream);

    await transport.createStarted;
    const terminal = await service.cancel("session-1");

    expect(terminal).toMatchObject({
      kind: "terminal",
      sourceType: "user.stop",
      status: "failed",
    });
    expect(transport.signal?.aborted).toBe(true);
    await expect(consuming).rejects.toThrow("aborted");
    expect((await store.loadMetadata("session-1")).activeTurnId).toBeUndefined();
  });

  it("uses remote cancellation, then aborts the local consumer", async () => {
    const store = await temporaryStore();
    await store.createSession("session-1");
    const transport = new BlockingTransport(true);
    const controller = new RunController(store, transport, () => "turn-stop");
    const service = new SessionService(store, () => controller, {});
    expect((await store.readJournal("session-1"))).toHaveLength(1);
    const stream = await service.continueSession("session-1", "Long task");
    const consuming = consume(stream);

    await transport.createStarted;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await store.loadMetadata("session-1")).responseId !== undefined) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const terminal = await service.cancel("session-1");

    expect(terminal).toMatchObject({
      kind: "terminal",
      sourceType: "response.cancel",
      status: "cancelled",
    });
    expect(transport.cancelCalls).toBe(1);
    expect(transport.signal?.aborted).toBe(true);
    await expect(consuming).rejects.toThrow("aborted");
    expect((await store.loadMetadata("session-1")).status).toBe("cancelled");
    expect((await store.loadMetadata("session-1")).activeTurnId).toBeUndefined();
  });

  it("records retry, edit, and explicit fork through one branch service", async () => {
    const store = await temporaryStore();
    await store.createSession("session-1");
    const service = createService(store, ["root", "retry", "edit", "fork"]);

    await consume(await service.continueSession("session-1", "Root"));
    await consume(await service.retryTurn("session-1", "root"));
    await consume(await service.editTurn("session-1", "root", "Edited"));
    await consume(await service.forkTurn("session-1", "root", "Continue here"));

    const inputs = (await store.readJournal("session-1")).filter(
      (record) => record.kind === "turn.input",
    );
    expect(inputs.map((input) => input.lineage)).toEqual([
      { parentTurnId: null },
      { parentTurnId: null, fork: { kind: "retry", sourceTurnId: "root" } },
      { parentTurnId: null, fork: { kind: "edit", sourceTurnId: "root" } },
      {
        parentTurnId: "root",
        fork: { kind: "explicit", sourceTurnId: "root" },
      },
    ]);
  });

  it("holds one cross-process lease for a data directory", async () => {
    const store = await temporaryStore();
    const release = await acquireDataDirectoryLease(store.rootDirectory);

    await expect(
      acquireDataDirectoryLease(store.rootDirectory),
    ).rejects.toMatchObject({ code: "ELOCKED" });

    await release();
    const releaseAgain = await acquireDataDirectoryLease(store.rootDirectory);
    await releaseAgain();
  });
});
