import { describe, expect, it } from "vitest";

import {
  JOURNAL_SCHEMA_VERSION,
  type JournalRecord,
  type RunConfigurationSnapshot,
} from "@mas-chat/protocol";

import { ReplayHistoryError } from "./errors.js";
import {
  buildReplayHistory,
  buildTurnPath,
  latestCompletedTurnId,
  resolveTurns,
} from "./history.js";

const base = {
  schemaVersion: JOURNAL_SCHEMA_VERSION,
  sessionId: "session-1",
  at: "2026-09-20T00:00:00.000Z",
} as const;

describe("stateless history replay", () => {
  it.each(["retry", "edit"] as const)(
    "keeps a completed root %s independent of earlier completed turns",
    (kind) => {
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
      const records: JournalRecord[] = [{ ...base, kind: "session.created" }];
      for (const turnId of ["root", "old-followup", "replacement"]) {
        records.push(
          {
            ...base,
            kind: "turn.input",
            turnId,
            lineage: {
              parentTurnId: turnId === "old-followup" ? "root" : null,
              ...(turnId === "replacement"
                ? { fork: { kind, sourceTurnId: "root" } }
                : {}),
            },
            items: [{ role: "user", content: `${turnId} question` }],
            configuration,
          },
          {
            ...base,
            kind: "turn.output",
            turnId,
            responseId: `resp-${turnId}`,
            status: "completed",
            items: [{ type: "message", role: "assistant", content: `${turnId} answer` }],
          },
        );
      }

      expect(resolveTurns(records).at(-1)?.parentTurnId).toBeNull();
      expect(buildTurnPath(records, "replacement").map((turn) => turn.input.turnId))
        .toEqual(["replacement"]);
      expect(buildReplayHistory(records, "replacement")).toEqual([
        { role: "user", content: "replacement question" },
        { type: "message", role: "assistant", content: "replacement answer" },
      ]);
    },
  );

  it("keeps linear parenting for legacy turns without lineage", () => {
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
    const records: JournalRecord[] = [{ ...base, kind: "session.created" }];
    for (const turnId of ["first", "second"]) {
      records.push(
        {
          ...base,
          kind: "turn.input",
          turnId,
          items: [{ role: "user", content: `${turnId} question` }],
          configuration,
        },
        {
          ...base,
          kind: "turn.output",
          turnId,
          responseId: `resp-${turnId}`,
          status: "completed",
          items: [{ type: "message", role: "assistant", content: `${turnId} answer` }],
        },
      );
    }

    expect(resolveTurns(records).map((turn) => turn.parentTurnId)).toEqual([null, "first"]);
    expect(buildReplayHistory(records)).toHaveLength(4);
  });

  it("replays every native output item in order without flattening", () => {
    const reasoning = {
      id: "rs_1",
      type: "reasoning",
      encrypted_content: "opaque-ciphertext",
      summary: [{ type: "summary_text", text: "Checked the source." }],
    };
    const search = {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        queries: ["query"],
        sources: [{ type: "url", url: "https://example.com" }],
      },
    };
    const assistant = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      status: "completed",
      content: [{ type: "output_text", text: "Answer", annotations: [] }],
    };
    const records: JournalRecord[] = [
      { ...base, kind: "session.created" },
      {
        ...base,
        kind: "turn.input",
        turnId: "turn-1",
        items: [{ type: "message", role: "user", content: "Question" }],
        configuration: {
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
        },
      },
      {
        ...base,
        kind: "turn.output",
        turnId: "turn-1",
        responseId: "resp_1",
        status: "completed",
        items: [reasoning, search, assistant],
      },
    ];

    expect(buildReplayHistory(records)).toEqual([
      { type: "message", role: "user", content: "Question" },
      reasoning,
      search,
      assistant,
    ]);
  });

  it("refuses to build the next turn while the current turn is incomplete", () => {
    const records: JournalRecord[] = [
      { ...base, kind: "session.created" },
      {
        ...base,
        kind: "turn.input",
        turnId: "turn-open",
        items: [{ type: "message", role: "user", content: "Question" }],
        configuration: {
          model: "gpt-6-astra",
          background: true,
          stream: true,
          store: false,
          instructions: "test",
          reasoning: {},
          text: {},
          tools: [],
          include: [],
        },
      },
    ];

    expect(() => buildReplayHistory(records)).toThrow(ReplayHistoryError);
  });

  it("does not treat a terminal event as replayable before output is committed", () => {
    const records: JournalRecord[] = [
      { ...base, kind: "session.created" },
      {
        ...base,
        kind: "turn.input",
        turnId: "turn-terminal-event",
        lineage: { parentTurnId: null },
        items: [{ type: "message", role: "user", content: "Question" }],
        configuration: {
          model: "gpt-6-astra",
          background: true,
          stream: true,
          store: false,
          reasoning: {},
          text: {},
          tools: [],
          include: [],
        },
      },
      {
        ...base,
        kind: "response.event",
        turnId: "turn-terminal-event",
        responseId: "resp-terminal-event",
        sequenceNumber: 0,
        event: {
          type: "response.completed",
          sequence_number: 0,
          response: {
            id: "resp-terminal-event",
            status: "completed",
            output: [],
          },
        },
      },
    ];

    expect(latestCompletedTurnId(records)).toBeNull();
  });

  it("does not replay input from a turn aborted before response creation", () => {
    const records: JournalRecord[] = [
      { ...base, kind: "session.created" },
      {
        ...base,
        kind: "turn.input",
        turnId: "turn-aborted",
        items: [{ type: "message", role: "user", content: "Not delivered" }],
        configuration: {
          model: "gpt-6-astra",
          background: true,
          stream: true,
          store: false,
          instructions: "test",
          reasoning: {},
          text: {},
          tools: [],
          include: [],
        },
      },
      {
        ...base,
        kind: "turn.aborted",
        turnId: "turn-aborted",
        error: { name: "NetworkError", message: "not sent" },
      },
    ];

    expect(buildReplayHistory(records)).toEqual([]);
  });

  it("replays only the selected completed branch", () => {
    const configuration: RunConfigurationSnapshot = {
      model: "gpt-6-astra",
      background: true,
      stream: true,
      store: false,
      instructions: "test",
      reasoning: {},
      text: {},
      tools: [],
      include: [],
    };
    const records: JournalRecord[] = [
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
        items: [{ type: "message", role: "assistant", content: "Root answer" }],
      },
      {
        ...base,
        kind: "turn.input",
        turnId: "failed",
        lineage: { parentTurnId: "root" },
        items: [{ type: "message", role: "user", content: "Try this" }],
        configuration,
      },
      {
        ...base,
        kind: "turn.failed",
        turnId: "failed",
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
        items: [{ type: "message", role: "user", content: "Try this" }],
        configuration,
      },
      {
        ...base,
        kind: "turn.output",
        turnId: "retry",
        responseId: "resp-retry",
        status: "completed",
        items: [{ type: "message", role: "assistant", content: "Retry answer" }],
      },
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
        items: [{ type: "message", role: "assistant", content: "Edited answer" }],
      },
    ];

    expect(buildReplayHistory(records, "retry")).toEqual([
      { type: "message", role: "user", content: "Root" },
      { type: "message", role: "assistant", content: "Root answer" },
      { type: "message", role: "user", content: "Try this" },
      { type: "message", role: "assistant", content: "Retry answer" },
    ]);
    expect(buildReplayHistory(records, "failed")).toEqual([
      { type: "message", role: "user", content: "Root" },
      { type: "message", role: "assistant", content: "Root answer" },
      { type: "message", role: "user", content: "Try this" },
    ]);
    expect(buildReplayHistory(records, "edit")).toEqual([
      { type: "message", role: "user", content: "Root" },
      { type: "message", role: "assistant", content: "Root answer" },
      { type: "message", role: "user", content: "Edited question" },
      { type: "message", role: "assistant", content: "Edited answer" },
    ]);
  });
});
