import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject, RunConfigurationSnapshot } from "@mas-chat/protocol";

import {
  parseJournal,
  SessionStore,
  type HistoricalJournalRecord,
} from "./journal.js";

const temporaryDirectories: string[] = [];

async function temporaryStore(): Promise<SessionStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "mas-chat-storage-"));
  temporaryDirectories.push(directory);
  return new SessionStore(directory);
}

const configuration: RunConfigurationSnapshot = {
  model: "gpt-6-astra",
  background: true,
  stream: true,
  store: false,
  instructions: "test",
  reasoning: { effort: "max", summary: "auto", context: "all_turns" },
  text: { verbosity: "medium" },
  tools: [{ type: "web_search" }],
  include: [
    "reasoning.encrypted_content",
    "web_search_call.action.sources",
  ],
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("session journal", () => {
  it("moves an idle session into the archive directory", async () => {
    const store = await temporaryStore();
    await store.createSession("to-archive");

    await store.archiveSession("to-archive");

    await expect(stat(path.join(store.sessionsDirectory, "to-archive"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(store.archivedSessionDirectory("to-archive"))).resolves.toBeTruthy();
    const listed = await store.listSessionSnapshots();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ archived: true, metadata: { sessionId: "to-archive" } });
  });

  it("lists sessions in most recently updated order", async () => {
    const store = await temporaryStore();
    await store.createSession("older", new Date("2026-09-20T00:00:00Z"));
    await store.createSession("newer", new Date("2026-09-21T00:00:00Z"));

    const sessions = await store.listSessions();

    expect(sessions.map((session) => session.sessionId)).toEqual([
      "newer",
      "older",
    ]);
    expect(sessions[0]).toMatchObject({ status: "idle", lastSequenceNumber: -1 });
  });

  it("inspects journal-derived state without repairing metadata", async () => {
    const store = await temporaryStore();
    await store.createSession("session-read");
    const metadataPath = store.metadataPath("session-read");
    const stale = JSON.parse(await readFile(metadataPath, "utf8")) as JsonObject;
    stale.status = "failed";
    const staleText = `${JSON.stringify(stale)}\n`;
    await writeFile(metadataPath, staleText, "utf8");

    const snapshot = await store.inspectSession("session-read");
    const listed = await store.listSessionSnapshots();

    expect(snapshot.metadata.status).toBe("idle");
    expect(listed[0]?.metadata.status).toBe("idle");
    expect(await readFile(metadataPath, "utf8")).toBe(staleText);
  });

  it("flushes events before advancing the cursor and ignores duplicate delivery", async () => {
    const store = await temporaryStore();
    await store.createSession("session-1", new Date("2026-09-20T00:00:00Z"));
    await store.beginTurn(
      "session-1",
      "turn-1",
      [{ type: "message", role: "user", content: "Hello" }],
      configuration,
    );

    const events: JsonObject[] = [
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp-1", status: "queued", output: [] },
      },
      {
        type: "response.in_progress",
        sequence_number: 1,
        response: { id: "resp-1", status: "in_progress", output: [] },
      },
      {
        type: "response.completed",
        sequence_number: 2,
        response: { id: "resp-1", status: "completed", output: [] },
      },
    ];

    await store.recordResponseEvent("session-1", "turn-1", "resp-1", events[0]!);
    await store.recordResponseEvent("session-1", "turn-1", "resp-1", events[1]!);
    const duplicate = await store.recordResponseEvent(
      "session-1",
      "turn-1",
      "resp-1",
      events[1]!,
    );
    expect(duplicate.duplicate).toBe(true);

    await store.recordResponseEvent("session-1", "turn-1", "resp-1", {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: "msg",
      output_index: 0,
      content_index: 0,
      delta: "sparse",
    });
    await store.recordResponseEvent("session-1", "turn-1", "resp-1", {
      type: "response.completed",
      sequence_number: 5,
      response: { id: "resp-1", status: "completed", output: [] },
    });
    await store.recordTurnOutput(
      "session-1",
      "turn-1",
      "resp-1",
      "completed",
      [{ id: "msg", type: "message", role: "assistant", content: [] }],
    );

    const metadata = await store.loadMetadata("session-1");
    expect(metadata).toMatchObject({
      status: "completed",
      responseId: "resp-1",
      lastSequenceNumber: 5,
    });
    expect(metadata.activeTurnId).toBeUndefined();

    const records = await store.readJournal("session-1");
    expect(records.map((record) => record.kind)).toEqual([
      "session.created",
      "turn.input",
      "response.event",
      "response.event",
      "response.event",
      "response.event",
      "turn.output",
    ]);

    expect(
      records
        .filter((record) => record.kind === "response.event")
        .map((record) => record.sequenceNumber),
    ).toEqual([0, 1, 3, 5]);
  });

  it("persists an unsequenced lifecycle event without advancing the provider cursor", async () => {
    const store = await temporaryStore();
    await store.createSession("session-1");
    await store.beginTurn(
      "session-1",
      "turn-1",
      [{ type: "message", role: "user", content: "Hello" }],
      configuration,
    );

    const result = await store.recordResponseEvent("session-1", "turn-1", "resp-1", {
      type: "response.created",
      response: { id: "resp-1", status: "queued", output: [] },
    });

    expect(result.duplicate).toBe(false);
    expect(result.metadata).toMatchObject({
      responseId: "resp-1",
      lastSequenceNumber: -1,
      status: "queued",
    });
    expect(await store.readJournal("session-1")).toContainEqual(
      expect.objectContaining({
        kind: "response.event",
        sequenceNumber: 0,
        unsequenced: true,
      }),
    );
  });

  it("preserves sequence zero after rebuilding an unsequenced bootstrap", async () => {
    const store = await temporaryStore();
    await store.createSession("session-1");
    await store.beginTurn(
      "session-1",
      "turn-1",
      [{ role: "user", content: "Hello" }],
      configuration,
    );
    await store.recordResponseEvent("session-1", "turn-1", "resp-1", {
      type: "response.created",
      response: { id: "resp-1", status: "in_progress", output: [] },
    });

    const reopened = new SessionStore(store.rootDirectory);
    expect((await reopened.inspectSession("session-1")).metadata.lastSequenceNumber)
      .toBe(-1);
    expect((await reopened.loadMetadata("session-1")).lastSequenceNumber).toBe(-1);

    const event: JsonObject = {
      type: "response.output_text.delta",
      sequence_number: 0,
      item_id: "msg-1",
      output_index: 0,
      content_index: 0,
      delta: "Hello",
    };
    const first = await reopened.recordResponseEvent("session-1", "turn-1", "resp-1", event);
    const duplicate = await reopened.recordResponseEvent("session-1", "turn-1", "resp-1", event);
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect((await reopened.loadMetadata("session-1")).lastSequenceNumber).toBe(0);
    const persisted = (await reopened.readJournal("session-1"))
      .filter((record) => record.kind === "response.event");
    expect(persisted.map((record) => record.event.type)).toEqual([
      "response.created",
      "response.output_text.delta",
    ]);
  });

  it("uses the acknowledged cursor for an unsequenced terminal event", async () => {
    const store = await temporaryStore();
    await store.createSession("session-1");
    await store.beginTurn(
      "session-1",
      "turn-1",
      [{ type: "message", role: "user", content: "Hello" }],
      configuration,
    );
    await store.recordResponseEvent("session-1", "turn-1", "resp-1", {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp-1", status: "in_progress", output: [] },
    });

    const result = await store.recordResponseEvent("session-1", "turn-1", "resp-1", {
      type: "response.failed",
      response: { id: "resp-1", status: "failed", output: [] },
    });

    expect(result.metadata.lastSequenceNumber).toBe(0);
    expect(await store.readJournal("session-1")).toContainEqual(
      expect.objectContaining({
        kind: "response.event",
        sequenceNumber: 0,
        unsequenced: true,
      }),
    );
  });

  it("creates an independent session from completed native history", async () => {
    const store = await temporaryStore();
    await store.createSession("source");
    await store.beginTurn(
      "source",
      "turn-1",
      [{ type: "message", role: "user", content: "Hello" }],
      configuration,
      { parentTurnId: null },
    );
    await store.recordResponseEvent("source", "turn-1", "resp-1", {
      type: "response.completed",
      sequence_number: 2,
      response: { id: "resp-1", status: "completed", output: [] },
    });
    await store.recordTurnOutput(
      "source",
      "turn-1",
      "resp-1",
      "completed",
      [{ id: "message-1", type: "message", role: "assistant", content: [] }],
    );
    const sourceRecords = await store.readJournal("source");
    const history = sourceRecords.filter(
      (record): record is HistoricalJournalRecord =>
        record.kind !== "session.created",
    );

    await store.createSessionFromHistory(
      "forked",
      history,
      { sourceSessionId: "source", sourceTurnId: "turn-1" },
      new Date("2026-09-26T00:00:00Z"),
    );

    const snapshot = await store.inspectSession("forked");
    expect(snapshot.metadata).toMatchObject({
      sessionId: "forked",
      status: "completed",
      fork: { sourceSessionId: "source", sourceTurnId: "turn-1" },
    });
    expect(snapshot.metadata.activeTurnId).toBeUndefined();
    expect(snapshot.records.map((record) => record.sessionId)).toEqual([
      "forked",
      "forked",
      "forked",
      "forked",
    ]);
    expect(snapshot.records[0]).toMatchObject({
      kind: "session.created",
      fork: { sourceSessionId: "source", sourceTurnId: "turn-1" },
    });
  });

  it("repairs a stale metadata cursor from the durable journal", async () => {
    const store = await temporaryStore();
    await store.createSession("session-repair");
    await store.beginTurn(
      "session-repair",
      "turn-1",
      [{ type: "message", role: "user", content: "Hello" }],
      configuration,
    );
    await store.recordResponseEvent("session-repair", "turn-1", "resp-1", {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp-1", status: "queued", output: [] },
    });

    const metadataPath = store.metadataPath("session-repair");
    const stale = JSON.parse(await readFile(metadataPath, "utf8")) as JsonObject;
    stale.lastSequenceNumber = -1;
    stale.responseId = null;
    await writeFile(metadataPath, JSON.stringify(stale), "utf8");

    const repaired = await store.loadMetadata("session-repair");
    expect(repaired.lastSequenceNumber).toBe(0);
    expect(repaired.responseId).toBe("resp-1");
  });

  it("ignores only a torn final JSONL line", async () => {
    const complete =
      '{"schemaVersion":1,"kind":"session.created","sessionId":"s","at":"2026-09-20T00:00:00.000Z"}\n';
    expect(parseJournal(`${complete}{"schemaVersion":`)).toHaveLength(1);
    expect(() => parseJournal(`${complete}{bad}\n`)).toThrow();

    const store = await temporaryStore();
    await store.createSession("session-torn");
    await appendFile(store.journalPath("session-torn"), '{"kind":', "utf8");
    expect(await store.readJournal("session-torn")).toHaveLength(1);
  });
});
