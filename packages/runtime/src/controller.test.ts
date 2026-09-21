import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ResponseCreateParamsStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";

import type { JsonObject, NormalizedEvent } from "@mas-chat/protocol";
import { SessionStore } from "@mas-chat/storage";

import { RunController } from "./controller.js";
import { StreamEndedWithoutTerminalError } from "./errors.js";
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
  }) {
    this.createEvents = options.createEvents ?? [];
    this.resumeEvents = options.resumeEvents ?? [];
    this.createError = options.createError;
  }

  async create(
    request: ResponseCreateParamsStreaming,
  ): Promise<AsyncIterable<JsonObject>> {
    this.requests.push(request);
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

    const metadata = await store.loadMetadata("session-1");
    expect(metadata.activeTurnId).toBeUndefined();
    expect(metadata.status).toBe("completed");
    const history = buildReplayHistory(await store.readJournal("session-1"));
    expect(history).toHaveLength(5);
    expect(history[1]).toMatchObject({
      type: "reasoning",
      encrypted_content: "encrypted-fixture",
    });
    expect(history[2]).toMatchObject({ type: "web_search_call" });
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
