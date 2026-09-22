import { describe, expect, it } from "vitest";

import {
  JOURNAL_SCHEMA_VERSION,
  type JournalRecord,
  type RunConfigurationSnapshot,
  type SessionMetadata,
} from "@mas-chat/protocol";

import { createSessionView } from "./session-view.js";

const at = "2026-09-21T00:00:00.000Z";
const base = {
  schemaVersion: JOURNAL_SCHEMA_VERSION,
  sessionId: "session-1",
  at,
} as const;
const configuration: RunConfigurationSnapshot = {
  model: "gpt-6-astra",
  background: true,
  stream: true,
  store: false,
  reasoning: {},
  text: {},
  tools: [],
  include: [],
};

function metadata(status: SessionMetadata["status"]): SessionMetadata {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    sessionId: "session-1",
    status,
    lastSequenceNumber: 2,
    createdAt: at,
    updatedAt: at,
    ...(status === "in_progress"
      ? { activeTurnId: "failed", responseId: "resp-failed" }
      : {}),
  };
}

function records(includeRetry: boolean): JournalRecord[] {
  const values: JournalRecord[] = [
    { ...base, kind: "session.created" },
    {
      ...base,
      kind: "turn.input",
      turnId: "root",
      lineage: { parentTurnId: null },
      items: [{ type: "message", role: "user", content: "Root" }],
      configuration,
    },
    {
      ...base,
      kind: "turn.output",
      turnId: "root",
      responseId: "resp-root",
      status: "completed",
      items: [
        {
          id: "msg-root",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Root answer" }],
        },
      ],
    },
    {
      ...base,
      kind: "turn.input",
      turnId: "failed",
      lineage: { parentTurnId: "root" },
      items: [{ type: "message", role: "user", content: "Question" }],
      configuration,
    },
    {
      ...base,
      kind: "response.event",
      turnId: "failed",
      responseId: "resp-failed",
      sequenceNumber: 0,
      event: {
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp-failed" },
      },
    },
    {
      ...base,
      kind: "response.event",
      turnId: "failed",
      responseId: "resp-failed",
      sequenceNumber: 1,
      event: {
        type: "response.output_item.added",
        sequence_number: 1,
        response_id: "resp-failed",
        output_index: 0,
        item: {
          id: "msg-partial",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          status: "in_progress",
          content: [],
        },
      },
    },
    {
      ...base,
      kind: "response.event",
      turnId: "failed",
      responseId: "resp-failed",
      sequenceNumber: 2,
      event: {
        type: "response.output_text.delta",
        sequence_number: 2,
        response_id: "resp-failed",
        item_id: "msg-partial",
        output_index: 0,
        delta: "Partial answer",
      },
    },
  ];
  if (includeRetry) {
    values.push(
      {
        ...base,
        kind: "turn.failed",
        turnId: "failed",
        responseId: "resp-failed",
        error: { name: "NetworkError", message: "cut off" },
      },
      {
        ...base,
        kind: "turn.input",
        turnId: "retry",
        lineage: {
          parentTurnId: "root",
          fork: { kind: "retry", sourceTurnId: "failed" },
        },
        items: [{ type: "message", role: "user", content: "Question" }],
        configuration,
      },
      {
        ...base,
        kind: "turn.output",
        turnId: "retry",
        responseId: "resp-retry",
        status: "completed",
        items: [
          {
            id: "msg-retry",
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Complete answer" }],
          },
        ],
      },
    );
  }
  return values;
}

describe("web session projection", () => {
  it("rebuilds partial text for an attachable unfinished turn", () => {
    const view = createSessionView(
      "session-1",
      metadata("in_progress"),
      records(false),
      undefined,
      false,
    );

    expect(view.recovery).toBe("attachable");
    expect(view.canContinue).toBe(true);
    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: "Partial answer",
          partial: true,
        }),
        expect.objectContaining({ text: "响应尚未完成" }),
      ]),
    );
  });

  it("projects retry siblings as versions without mixing the failed output", () => {
    const view = createSessionView(
      "session-1",
      metadata("completed"),
      records(true),
      "retry",
      false,
    );

    expect(view.messages.map((message) => message.text)).toEqual([
      "Root",
      "Root answer",
      "Question",
      "Complete answer",
    ]);
    const retriedUser = view.messages.find(
      (message) => message.turnId === "retry" && message.role === "user",
    );
    expect(retriedUser?.versions).toHaveLength(2);
    expect(retriedUser?.versionIndex).toBe(1);
    expect(retriedUser?.forkable).toBe(true);
  });

  it("projects an edited prompt as another sibling version", () => {
    const editedRecords = records(true);
    editedRecords.push(
      {
        ...base,
        kind: "turn.input",
        turnId: "edit",
        lineage: {
          parentTurnId: "root",
          fork: { kind: "edit", sourceTurnId: "retry" },
        },
        items: [{ type: "message", role: "user", content: "Edited question" }],
        configuration,
      },
      {
        ...base,
        kind: "turn.output",
        turnId: "edit",
        responseId: "resp-edit",
        status: "completed",
        items: [
          {
            id: "msg-edit",
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Edited answer" }],
          },
        ],
      },
    );

    const view = createSessionView(
      "session-1",
      metadata("completed"),
      editedRecords,
      "edit",
      false,
    );

    expect(view.messages.map((message) => message.text)).toEqual([
      "Root",
      "Root answer",
      "Edited question",
      "Edited answer",
    ]);
    const editedUser = view.messages.find(
      (message) => message.turnId === "edit" && message.role === "user",
    );
    expect(editedUser?.versions).toHaveLength(3);
    expect(editedUser?.versionIndex).toBe(2);
  });

  it("blocks all other branches while one turn is active", () => {
    const view = createSessionView(
      "session-1",
      metadata("in_progress"),
      records(false),
      "root",
      false,
    );

    expect(view.headTurnId).toBe("root");
    expect(view.canContinue).toBe(false);
    expect(
      view.messages.find(
        (message) => message.turnId === "root" && message.role === "user",
      )?.retryable,
    ).toBe(false);
  });

  it("does not advertise attach when no response ID was persisted", () => {
    const activeWithoutResponseId = metadata("in_progress");
    delete activeWithoutResponseId.responseId;

    const view = createSessionView(
      "session-1",
      activeWithoutResponseId,
      records(false),
      undefined,
      false,
    );

    expect(view.recovery).toBeUndefined();
    expect(view.canContinue).toBe(false);
  });

  it("allows a new message after a terminal failed turn", () => {
    const view = createSessionView(
      "session-1",
      metadata("completed"),
      records(true),
      "failed",
      false,
    );

    expect(view.status).toBe("failed");
    expect(view.canContinue).toBe(true);
  });
});
