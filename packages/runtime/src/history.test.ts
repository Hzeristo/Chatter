import { describe, expect, it } from "vitest";

import {
  JOURNAL_SCHEMA_VERSION,
  type JournalRecord,
} from "@mas-chat/protocol";

import { ReplayHistoryError } from "./errors.js";
import { buildReplayHistory } from "./history.js";

const base = {
  schemaVersion: JOURNAL_SCHEMA_VERSION,
  sessionId: "session-1",
  at: "2026-09-20T00:00:00.000Z",
} as const;

describe("stateless history replay", () => {
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
});
