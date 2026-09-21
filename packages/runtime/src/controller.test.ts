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
    rejectBackground?: boolean;
  }) {
    this.createEvents = options.createEvents ?? [];
    this.resumeEvents = options.resumeEvents ?? [];
    this.createError = options.createError;
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
    return events(this.createEvents);
  }

  async cancel(_responseId: string): Promise<JsonObject> {
    return this.cancelResponse;
  }

  async resume(
    responseId: string,
    startingAfter: number,
  ): Promise<AsyncIterable<JsonObject>> {
    this.resumeCalls.push({ responseId, startingAfter });
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

  it("keeps an interrupted response attachable and resumes after the durable cursor", async () => {
    const store = await temporaryStore();
    const fixture = await loadFixture();
    const transport = new FakeTransport({
      createEvents: fixture.slice(0, 10),
      resumeEvents: fixture.slice(10),
    });
    const controller = new RunController(store, transport, () => "turn-1");
    const input = [{ role: "user", content: "Question" }] as ResponseInputItem[];

    await expect(
      collect(controller.start(input, { sessionId: "session-1" })),
    ).rejects.toBeInstanceOf(StreamEndedWithoutTerminalError);

    const interrupted = await store.loadMetadata("session-1");
    expect(interrupted).toMatchObject({
      activeTurnId: "turn-1",
      responseId: "resp_fixture",
      lastSequenceNumber: 9,
    });

    const resumed = await collect(controller.attach("session-1"));
    expect(transport.resumeCalls).toEqual([
      { responseId: "resp_fixture", startingAfter: 9 },
    ]);
    expect(resumed.at(-1)).toMatchObject({
      kind: "terminal",
      status: "completed",
    });
    expect((await store.loadMetadata("session-1")).activeTurnId).toBeUndefined();
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

  it("records cancellation as a terminal snapshot without inventing an SSE cursor", async () => {
    const store = await temporaryStore();
    const fixture = await loadFixture();
    const transport = new FakeTransport({ createEvents: fixture.slice(0, 2) });
    const controller = new RunController(store, transport, () => "turn-cancel");
    const input = [{ role: "user", content: "Long task" }] as ResponseInputItem[];

    await expect(
      collect(controller.start(input, { sessionId: "session-1" })),
    ).rejects.toBeInstanceOf(StreamEndedWithoutTerminalError);
    const before = await store.loadMetadata("session-1");
    expect(before.lastSequenceNumber).toBe(1);

    const terminal = await controller.cancel("session-1");
    expect(terminal).toMatchObject({
      kind: "terminal",
      sourceType: "response.cancel",
      sequenceNumber: 1,
      status: "cancelled",
    });
    const after = await store.loadMetadata("session-1");
    expect(after.lastSequenceNumber).toBe(1);
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
