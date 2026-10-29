import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ResponseCreateParamsStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";

import type {
  JsonObject,
  NormalizedEvent,
  RunConfigurationSnapshot,
} from "@mas-chat/protocol";
import { SessionStore } from "@mas-chat/storage";

import { RunController } from "./controller.js";
import {
  ForegroundResponseNotCancellableError,
  ForegroundResponseNotResumableError,
  StreamEndedWithoutTerminalError,
} from "./errors.js";
import { buildReplayHistory } from "./history.js";
import type { ResponsesTransport } from "./transport.js";

const temporaryDirectories: string[] = [];

async function temporaryStore(): Promise<SessionStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "mas-chat-controller-"));
  temporaryDirectories.push(directory);
  const store = new SessionStore(directory);
  await store.createSession("session-1");
  return store;
}

async function loadFixture(): Promise<JsonObject[]> {
  const text = await readFile(
    new URL("../test/fixtures/interleaved-web-search.jsonl", import.meta.url),
    "utf8",
  );
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JsonObject);
}

async function* events(values: JsonObject[]): AsyncGenerator<JsonObject> {
  yield* values;
}

async function* eventsThenError(
  values: JsonObject[],
  error: Error,
): AsyncGenerator<JsonObject> {
  yield* values;
  throw error;
}

async function collect(
  stream: AsyncIterable<NormalizedEvent>,
): Promise<NormalizedEvent[]> {
  const collected: NormalizedEvent[] = [];
  for await (const event of stream) {
    collected.push(event);
  }
  return collected;
}

class FakeTransport implements ResponsesTransport {
  readonly createEvents: JsonObject[];
  readonly resumeEvents: JsonObject[];
  readonly createError: Error | undefined;
  readonly resumeError: Error | undefined;
  readonly streamError: Error | undefined;
  readonly rejectBackground: boolean;
  readonly requests: ResponseCreateParamsStreaming[] = [];
  readonly resumeCalls: Array<{ responseId: string; startingAfter: number }> = [];
  cancelResponse: JsonObject = {
    id: "resp_fixture",
    status: "cancelled",
    output: [],
  };

  constructor(options: {
    createEvents?: JsonObject[];
    resumeEvents?: JsonObject[];
    createError?: Error;
    resumeError?: Error;
    streamError?: Error;
    rejectBackground?: boolean;
  }) {
    this.createEvents = options.createEvents ?? [];
    this.resumeEvents = options.resumeEvents ?? [];
    this.createError = options.createError;
    this.resumeError = options.resumeError;
    this.streamError = options.streamError;
    this.rejectBackground = options.rejectBackground ?? false;
  }

  async create(
    request: ResponseCreateParamsStreaming,
  ): Promise<AsyncIterable<JsonObject>> {
    this.requests.push(request);
    if (request.background === true && this.rejectBackground) {
      throw Object.assign(new Error("400 Unsupported parameter: background"), {
        status: 400,
      });
    }
    if (this.createError !== undefined) {
      throw this.createError;
    }
    return this.streamError === undefined
      ? events(this.createEvents)
      : eventsThenError(this.createEvents, this.streamError);
  }

  async cancel(_responseId: string): Promise<JsonObject> {
    return this.cancelResponse;
  }

  async resume(
    responseId: string,
    startingAfter: number,
  ): Promise<AsyncIterable<JsonObject>> {
    this.resumeCalls.push({ responseId, startingAfter });
    if (this.resumeError !== undefined) {
      throw this.resumeError;
    }
    return events(this.resumeEvents);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("RunController", () => {
  it("ignores unsequenced Codex sideband events before and during a response", async () => {
    const store = await temporaryStore();
    const rateLimits = {
      type: "codex.rate_limits",
      plan_type: "plus",
      rate_limits: { allowed: true },
    };
    const responseMetadata = {
      type: "codex.response.metadata",
      headers: { "x-codex-turn-state": "sensitive-state" },
    };
    const otherSideband = { type: "codex.other_metadata", detail: "sideband" };
    const transport = new FakeTransport({
      createEvents: [
        rateLimits,
        responseMetadata,
        otherSideband,
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "resp-rate-limits", status: "queued", output: [] },
        },
        rateLimits,
        responseMetadata,
        otherSideband,
        {
          type: "response.completed",
          sequence_number: 1,
          response: { id: "resp-rate-limits", status: "completed", output: [] },
        },
      ],
    });
    const controller = new RunController(store, transport, () => "turn-rate-limits");

    const events = await collect(
      controller.start(
        [{ role: "user", content: "Question" }] as ResponseInputItem[],
        { sessionId: "session-1" },
      ),
    );

    expect(events.map((event) => event.sequenceNumber)).toEqual([0, 1]);
    expect((await store.loadMetadata("session-1"))).toMatchObject({
      status: "completed",
      lastSequenceNumber: 1,
    });
    expect(
      (await store.readJournal("session-1"))
        .filter((record) => record.kind === "response.event")
        .map((record) => record.event.type),
    ).toEqual(["response.created", "response.completed"]);
  });

  it("accepts a terminal event after unsequenced transport timing telemetry", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({
      createEvents: [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "resp-timing", status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.done",
          sequence_number: 40,
          output_index: 0,
          item: { id: "msg-timing", type: "message", role: "assistant", status: "completed", content: [] },
        },
        { type: "responsesapi.websocket_timing", timing_metrics: { elapsed_ms: 10 } },
        {
          type: "response.completed",
          sequence_number: 41,
          response: {
            id: "resp-timing",
            status: "completed",
            output: [{ id: "msg-timing", type: "message", role: "assistant", content: [] }],
          },
        },
      ],
    });
    const controller = new RunController(store, transport, () => "turn-timing");

    const events = await collect(
      controller.start(
        [{ role: "user", content: "Question" }] as ResponseInputItem[],
        { sessionId: "session-1" },
      ),
    );

    expect(events.at(-1)).toMatchObject({
      kind: "terminal",
      sequenceNumber: 41,
      status: "completed",
    });
    expect((await store.loadMetadata("session-1"))).toMatchObject({
      status: "completed",
      lastSequenceNumber: 41,
    });
    expect((await store.readJournal("session-1")).at(-1)).toMatchObject({
      kind: "turn.output",
      status: "completed",
      items: [expect.objectContaining({ id: "msg-timing" })],
    });
  });

  it("commits a terminal response when the provider omits its sequence number", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({
      createEvents: [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "resp-unsequenced-failed", status: "in_progress", output: [] },
        },
        {
          type: "response.in_progress",
          sequence_number: 1,
          response: { id: "resp-unsequenced-failed", status: "in_progress", output: [] },
        },
        {
          type: "response.failed",
          response: { id: "resp-unsequenced-failed", status: "failed", output: [] },
        },
      ],
    });
    const controller = new RunController(store, transport, () => "turn-unsequenced-failed");

    const events = await collect(
      controller.start(
        [{ role: "user", content: "Question" }] as ResponseInputItem[],
        { sessionId: "session-1" },
      ),
    );

    expect(events.at(-1)).toMatchObject({
      kind: "terminal",
      sequenceNumber: 1,
      status: "failed",
    });
    expect((await store.loadMetadata("session-1"))).toMatchObject({
      status: "failed",
      lastSequenceNumber: 1,
    });
    expect((await store.readJournal("session-1"))
      .filter((record) => record.kind === "response.event")
      .at(-1)).toMatchObject({
        sequenceNumber: 1,
        unsequenced: true,
      });
  });

  it("resumes an unsequenced bootstrap before zero and persists duplicate delivery once", async () => {
    const store = await temporaryStore();
    await store.beginTurn(
      "session-1",
      "turn-bootstrap",
      [{ role: "user", content: "Question" }],
      {
        model: "test-model", background: true, stream: true, store: false,
        reasoning: {}, text: {}, tools: [], include: [],
      },
    );
    await store.recordResponseEvent("session-1", "turn-bootstrap", "resp-bootstrap", {
      type: "response.created",
      response: { id: "resp-bootstrap", status: "in_progress", output: [] },
    });
    const delta: JsonObject = {
      type: "response.output_text.delta",
      sequence_number: 0,
      item_id: "msg-bootstrap",
      output_index: 0,
      content_index: 0,
      delta: "Recovered",
    };
    const transport = new FakeTransport({ resumeEvents: [
      delta,
      delta,
      {
        type: "response.completed",
        sequence_number: 1,
        response: {
          id: "resp-bootstrap", status: "completed",
          output: [{
            id: "msg-bootstrap", type: "message", role: "assistant",
            content: [{ type: "output_text", text: "Recovered", annotations: [] }],
          }],
        },
      },
    ] });
    const reopened = new SessionStore(store.rootDirectory);
    const normalized = await collect(new RunController(reopened, transport).attach("session-1"));

    expect(transport.resumeCalls).toEqual([{ responseId: "resp-bootstrap", startingAfter: -1 }]);
    expect(normalized.filter((event) => event.kind === "assistant_text"))
      .toEqual([expect.objectContaining({ sequenceNumber: 0, delta: "Recovered" })]);
    const records = await reopened.readJournal("session-1");
    expect(records.filter((record) => record.kind === "response.event")
      .map((record) => record.event.type)).toEqual([
      "response.created", "response.output_text.delta", "response.completed",
    ]);
    expect((await reopened.loadMetadata("session-1"))).toMatchObject({
      status: "completed", lastSequenceNumber: 1,
    });
    expect(buildReplayHistory(records).at(-1)).toMatchObject({
      id: "msg-bootstrap",
      content: [{ type: "output_text", text: "Recovered", annotations: [] }],
    });
  });

  it("reports an unsequenced upstream error as a stream failure", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({
      createEvents: [{ type: "error", message: "upstream unavailable" }],
    });
    const controller = new RunController(store, transport, () => "turn-error");

    await expect(
      collect(
        controller.start(
          [{ role: "user", content: "Question" }] as ResponseInputItem[],
          { sessionId: "session-1" },
        ),
      ),
    ).rejects.toMatchObject({
      name: "ResponseStreamError",
      message: "Response stream error: upstream unavailable",
    });
    expect((await store.readJournal("session-1")).at(-1)).toMatchObject({
      kind: "turn.failed",
      error: { name: "ResponseStreamError" },
    });
  });

  it("records an invalid event shape without persisting its payload", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({
      createEvents: [
        { type: "response.output_text.delta", delta: "private content" },
      ],
    });
    const controller = new RunController(store, transport, () => "turn-invalid");

    await expect(
      collect(
        controller.start(
          [{ role: "user", content: "Question" }] as ResponseInputItem[],
          { sessionId: "session-1" },
        ),
      ),
    ).rejects.toMatchObject({ name: "ResponseSequenceError" });

    const failure = (await store.readJournal("session-1")).at(-1);
    expect(failure).toMatchObject({
      kind: "turn.failed",
      error: {
        eventType: "response.output_text.delta",
        eventKeys: ["delta", "type"],
      },
    });
    expect(JSON.stringify(failure)).not.toContain("private content");
  });

  it("persists each event before exposing it and commits replayable output", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({ createEvents: await loadFixture() });
    const controller = new RunController(store, transport, () => "turn-1");
    const input = [
      { role: "user", content: "Find the state guidance" },
    ] as ResponseInputItem[];
    const normalized: NormalizedEvent[] = [];

    for await (const event of controller.start(input, { sessionId: "session-1" })) {
      const metadata = await store.loadMetadata("session-1");
      expect(metadata.lastSequenceNumber).toBeGreaterThanOrEqual(
        event.sequenceNumber,
      );
      normalized.push(event);
    }

    expect(normalized.at(-1)).toMatchObject({
      kind: "terminal",
      status: "completed",
    });
    expect(transport.requests[0]).toMatchObject({
      store: false,
      background: true,
      stream: true,
    });
    expect(transport.requests[0]).not.toHaveProperty("previous_response_id");
    expect(transport.requests[0]?.instructions).toContain(
      "Help the user complete",
    );
    expect(transport.requests[0]?.instructions).toContain(
      "Continue the established conversation",
    );

    const metadata = await store.loadMetadata("session-1");
    expect(metadata.activeTurnId).toBeUndefined();
    expect(metadata.status).toBe("completed");
    const history = buildReplayHistory(await store.readJournal("session-1"));
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          encrypted_content: "encrypted-fixture",
        }),
        expect.objectContaining({ type: "web_search_call" }),
      ]),
    );
  });

  it("uses the base prompt once and sends exactly one following cue on later turns", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({ createEvents: await loadFixture() });
    const turnIds = ["turn-1", "turn-2"];
    const controller = new RunController(
      store,
      transport,
      () => turnIds.shift()!,
    );
    const options = {
      sessionId: "session-1",
      developerPrompt: "Base behavior",
      sessionFollowingInstruction: "Follow the established thread",
    } as const;

    await collect(
      controller.start(
        [{ role: "user", content: "First" }] as ResponseInputItem[],
        options,
      ),
    );
    await collect(
      controller.start(
        [{ role: "user", content: "Second" }] as ResponseInputItem[],
        options,
      ),
    );

    expect(transport.requests[0]?.instructions).toBe(
      "Base behavior\n\nFollow the established thread",
    );
    expect(transport.requests[1]?.instructions).toBe(
      "Follow the established thread",
    );

    const records = await store.readJournal("session-1");
    const turnInputs = records.filter((record) => record.kind === "turn.input");
    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[0]!.configuration.instructions).toBe(
      "Base behavior\n\nFollow the established thread",
    );
    expect(turnInputs[1]!.configuration.instructions).toBe(
      "Follow the established thread",
    );
    expect(turnInputs[0]!.items).toEqual([{ role: "user", content: "First" }]);
    expect(turnInputs[1]!.items).toEqual([{ role: "user", content: "Second" }]);
    expect(
      buildReplayHistory(records).some(
        (item) => "role" in item && item.role === "developer",
      ),
    ).toBe(false);
  });

  it("fails when a response stream ends without a terminal event", async () => {
    const store = await temporaryStore();
    const fixture = await loadFixture();
    const transport = new FakeTransport({
      createEvents: fixture.slice(0, 10),
    });
    const controller = new RunController(store, transport, () => "turn-1");
    const input = [{ role: "user", content: "Question" }] as ResponseInputItem[];

    await expect(
      collect(controller.start(input, { sessionId: "session-1" })),
    ).rejects.toBeInstanceOf(StreamEndedWithoutTerminalError);

    const interrupted = await store.loadMetadata("session-1");
    expect(interrupted).toMatchObject({
      responseId: "resp_fixture",
      lastSequenceNumber: 9,
      status: "failed",
    });
    expect(interrupted.activeTurnId).toBeUndefined();
    expect((await store.readJournal("session-1")).at(-1)).toMatchObject({
      kind: "turn.failed",
      turnId: "turn-1",
    });
  });

  it("aborts a local turn when request creation fails before a response exists", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({
      createError: new Error("offline fixture failure"),
    });
    const controller = new RunController(store, transport, () => "turn-failed");
    const input = [{ role: "user", content: "Never sent" }] as ResponseInputItem[];

    await expect(
      collect(controller.start(input, { sessionId: "session-1" })),
    ).rejects.toThrow("offline fixture failure");

    const metadata = await store.loadMetadata("session-1");
    expect(metadata.status).toBe("failed");
    expect(metadata.activeTurnId).toBeUndefined();
    expect(buildReplayHistory(await store.readJournal("session-1"))).toEqual([]);
  });

  it("falls back once to foreground only for an explicit unsupported-background error", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({
      createEvents: await loadFixture(),
      rejectBackground: true,
    });
    const turnIds = ["turn-background", "turn-foreground"];
    const controller = new RunController(
      store,
      transport,
      () => turnIds.shift()!,
    );
    const input = [{ role: "user", content: "Question" }] as ResponseInputItem[];

    const normalized = await collect(
      controller.start(input, {
        sessionId: "session-1",
        backgroundFallback: "on_unsupported",
      }),
    );

    expect(normalized.at(-1)).toMatchObject({
      kind: "terminal",
      status: "completed",
    });
    expect(transport.requests.map((request) => request.background)).toEqual([
      true,
      undefined,
    ]);
    const records = await store.readJournal("session-1");
    expect(
      records
        .filter((record) => record.kind === "turn.input")
        .map((record) => record.configuration.background),
    ).toEqual([true, false]);
    expect(records.map((record) => record.kind)).toContain("turn.aborted");
    expect(transport.requests[0]?.instructions).toBe(
      transport.requests[1]?.instructions,
    );
    const successfulTurn = records.findLast(
      (record) => record.kind === "turn.input",
    );
    expect(successfulTurn?.kind).toBe("turn.input");
    if (successfulTurn?.kind === "turn.input") {
      expect(successfulTurn.configuration.instructions).toContain(
        "Help the user complete",
      );
      expect(successfulTurn.configuration.instructions).toContain(
        "Continue the established conversation",
      );
      expect(successfulTurn.lineage).toEqual({
        parentTurnId: null,
        fork: {
          kind: "transport_fallback",
          sourceTurnId: "turn-background",
        },
      });
    }
  });

  it("does not fallback for other 400 responses", async () => {
    const store = await temporaryStore();
    const error = Object.assign(new Error("400 Unsupported model"), {
      status: 400,
    });
    const transport = new FakeTransport({ createError: error });
    const controller = new RunController(store, transport, () => "turn-1");
    const input = [{ role: "user", content: "Question" }] as ResponseInputItem[];

    await expect(
      collect(
        controller.start(input, {
          sessionId: "session-1",
          backgroundFallback: "on_unsupported",
        }),
      ),
    ).rejects.toThrow("Unsupported model");
    expect(transport.requests).toHaveLength(1);
  });

  it("marks a disconnected foreground fallback failed instead of leaving it attachable", async () => {
    const store = await temporaryStore();
    const fixture = await loadFixture();
    const transport = new FakeTransport({
      createEvents: fixture.slice(0, 2),
      rejectBackground: true,
    });
    const turnIds = ["turn-background", "turn-foreground"];
    const controller = new RunController(
      store,
      transport,
      () => turnIds.shift()!,
    );
    const input = [{ role: "user", content: "Question" }] as ResponseInputItem[];

    await expect(
      collect(
        controller.start(input, {
          sessionId: "session-1",
          backgroundFallback: "on_unsupported",
        }),
      ),
    ).rejects.toBeInstanceOf(StreamEndedWithoutTerminalError);

    const metadata = await store.loadMetadata("session-1");
    expect(metadata.status).toBe("failed");
    expect(metadata.activeTurnId).toBeUndefined();
    expect((await store.readJournal("session-1")).at(-1)).toMatchObject({
      kind: "turn.failed",
      responseId: "resp_fixture",
    });
    expect(
      buildReplayHistory(await store.readJournal("session-1")),
    ).toEqual([]);
  });

  it("rejects attach and server cancellation for an active foreground turn", async () => {
    const store = await temporaryStore();
    const configuration: RunConfigurationSnapshot = {
      model: "gpt-6-astra",
      background: false,
      stream: true,
      store: false,
      instructions: "test",
      reasoning: { effort: "max", summary: "auto", context: "all_turns" },
      text: { verbosity: "medium" },
      tools: [],
      include: ["reasoning.encrypted_content"],
    };
    await store.beginTurn(
      "session-1",
      "turn-foreground",
      [{ role: "user", content: "Question" }],
      configuration,
    );
    await store.recordResponseEvent(
      "session-1",
      "turn-foreground",
      "resp-foreground",
      {
        type: "response.created",
        sequence_number: 0,
        response: {
          id: "resp-foreground",
          status: "in_progress",
          output: [],
        },
      },
    );
    const controller = new RunController(store, new FakeTransport({}));

    await expect(collect(controller.attach("session-1"))).rejects.toBeInstanceOf(
      ForegroundResponseNotResumableError,
    );
    await expect(controller.cancel("session-1")).rejects.toBeInstanceOf(
      ForegroundResponseNotCancellableError,
    );
  });

  it("commits remote HTTP stream errors as failed instead of leaving background work attachable", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({
      streamError: Object.assign(new Error("429 rate limited"), {
        status: 429,
      }),
      createEvents: [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "resp-remote-error", status: "in_progress", output: [] },
        },
      ],
    });
    const controller = new RunController(store, transport, () => "turn-remote-error");

    await expect(
      collect(
        controller.start(
          [{ role: "user", content: "Question" }] as ResponseInputItem[],
          { sessionId: "session-1" },
        ),
      ),
    ).rejects.toMatchObject({ status: 429 });

    const metadata = await store.loadMetadata("session-1");
    expect(metadata.status).toBe("failed");
    expect(metadata.activeTurnId).toBeUndefined();
    expect((await store.readJournal("session-1")).at(-1)).toMatchObject({
      kind: "turn.failed",
      turnId: "turn-remote-error",
      responseId: "resp-remote-error",
    });
  });

  it("commits non-HTTP streaming errors as failed instead of leaving background work attachable", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({
      streamError: new Error("socket closed during stream"),
      createEvents: [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "resp-stream-error", status: "in_progress", output: [] },
        },
      ],
    });
    const controller = new RunController(store, transport, () => "turn-stream-error");

    await expect(
      collect(
        controller.start(
          [{ role: "user", content: "Question" }] as ResponseInputItem[],
          { sessionId: "session-1" },
        ),
      ),
    ).rejects.toThrow("socket closed during stream");

    const metadata = await store.loadMetadata("session-1");
    expect(metadata.status).toBe("failed");
    expect(metadata.activeTurnId).toBeUndefined();
    expect((await store.readJournal("session-1")).at(-1)).toMatchObject({
      kind: "turn.failed",
      turnId: "turn-stream-error",
      responseId: "resp-stream-error",
    });
  });

  it("fails immediately on an upstream response stream error event", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({
      createEvents: [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "resp-error-event", status: "in_progress", output: [] },
        },
        {
          type: "error",
          sequence_number: 1,
          code: "server_error",
          message: "upstream stream failed",
          param: null,
        },
      ],
    });
    const controller = new RunController(store, transport, () => "turn-error-event");

    await expect(
      collect(
        controller.start(
          [{ role: "user", content: "Question" }] as ResponseInputItem[],
          { sessionId: "session-1" },
        ),
      ),
    ).rejects.toMatchObject({
      name: "ResponseStreamError",
      message: "Response stream error: upstream stream failed",
    });

    const metadata = await store.loadMetadata("session-1");
    expect(metadata.status).toBe("failed");
    expect(metadata.activeTurnId).toBeUndefined();
    expect((await store.readJournal("session-1")).at(-1)).toMatchObject({
      kind: "turn.failed",
      turnId: "turn-error-event",
      responseId: "resp-error-event",
    });
  });

  it("records cancellation as a terminal snapshot without inventing an SSE cursor", async () => {
    const store = await temporaryStore();
    const transport = new FakeTransport({
      createEvents: [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "resp_cancel", status: "in_progress", output: [] },
        },
      ],
    });
    const controller = new RunController(store, transport, () => "turn-cancel");
    const input = [{ role: "user", content: "Long task" }] as ResponseInputItem[];

    const stream = controller.start(input, { sessionId: "session-1" });
    const first = await stream.next();
    expect(first.value).toMatchObject({ kind: "lifecycle", status: "queued" });
    const before = await store.loadMetadata("session-1");
    expect(before.lastSequenceNumber).toBe(0);

    const terminal = await controller.cancel("session-1");
    expect(terminal).toMatchObject({
      kind: "terminal",
      sourceType: "response.cancel",
      sequenceNumber: 0,
      status: "cancelled",
    });
    const after = await store.loadMetadata("session-1");
    expect(after.lastSequenceNumber).toBe(0);
    expect(after.status).toBe("cancelled");
    expect(after.activeTurnId).toBeUndefined();

    const output = (await store.readJournal("session-1")).at(-1);
    expect(output).toMatchObject({
      kind: "turn.output",
      status: "cancelled",
      response: { status: "cancelled" },
    });
  });
});
