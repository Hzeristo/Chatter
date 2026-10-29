import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "@mas-chat/protocol";

import { ResponseSequenceError } from "./errors.js";
import { createResponseProjection, reduceResponseEvent } from "./reducer.js";

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

describe("response event reducer", () => {
  it("preserves interleaved reasoning, hosted-tool, commentary, and final state", async () => {
    let state = createResponseProjection();
    const normalizedKinds: string[] = [];

    for (const event of await loadFixture()) {
      const result = reduceResponseEvent(state, event);
      state = result.state;
      normalizedKinds.push(...result.normalized.map((item) => item.kind));
    }

    expect(state.responseId).toBe("resp_fixture");
    expect(state.lastSequenceNumber).toBe(18);
    expect(state.status).toBe("completed");
    expect(state.reasoning.rs_fixture?.summary).toBe("I should search first. ");
    expect(state.tools.ws_fixture).toMatchObject({
      status: "completed",
      toolType: "web_search_call",
      action: {
        type: "search",
        queries: ["stateless Responses replay"],
      },
    });
    expect(state.assistantMessages.msg_commentary).toMatchObject({
      phase: "commentary",
      text: "I found the relevant state guidance.",
    });
    expect(state.assistantMessages.msg_final).toMatchObject({
      phase: "final_answer",
      text: "Replay every native output item.",
    });
    expect(state.assistantMessages.msg_final?.annotations).toHaveLength(1);
    expect(state.usage).toMatchObject({ total_tokens: 150 });
    expect(normalizedKinds).toContain("reasoning");
    expect(normalizedKinds).toContain("tool");
    expect(normalizedKinds).toContain("annotation");
    expect(normalizedKinds.at(-1)).toBe("terminal");
  });

  it("drops duplicate replay and accepts sparse sequence numbers", async () => {
    const fixture = await loadFixture();
    let state = createResponseProjection();

    for (const event of fixture.slice(0, 10)) {
      state = reduceResponseEvent(state, event).state;
    }

    const duplicate = reduceResponseEvent(state, fixture[8]!);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.state).toBe(state);

    const sparse = reduceResponseEvent(state, fixture[11]!);
    expect(sparse.duplicate).toBe(false);
    expect(sparse.state.lastSequenceNumber).toBe(11);
  });

  it("rejects invalid sequence numbers", () => {
    expect(() =>
      reduceResponseEvent(createResponseProjection(), {
        type: "response.created",
        sequence_number: -1,
        response: { id: "resp_invalid", status: "queued", output: [] },
      }),
    ).toThrow(ResponseSequenceError);
  });

  it("accepts an unsequenced lifecycle bootstrap without advancing the cursor", () => {
    const bootstrap = reduceResponseEvent(createResponseProjection(), {
      type: "response.created",
      response: { id: "resp_bootstrap", status: "queued", output: [] },
    });

    expect(bootstrap.unsequenced).toBe(true);
    expect(bootstrap.state.responseId).toBe("resp_bootstrap");
    expect(bootstrap.state.lastSequenceNumber).toBe(-1);

    const firstSequenced = reduceResponseEvent(bootstrap.state, {
      type: "response.in_progress",
      sequence_number: 0,
      response: { id: "resp_bootstrap", status: "in_progress", output: [] },
    });
    expect(firstSequenced.unsequenced).toBeUndefined();
    expect(firstSequenced.state.lastSequenceNumber).toBe(0);
  });

  it("reports the shape of an unsequenced content event", () => {
    expect(() =>
      reduceResponseEvent(createResponseProjection(), {
        type: "response.output_text.delta",
        delta: "diagnose me",
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ResponseSequenceError",
        message: "Response event missing sequence_number: expected 0",
        eventType: "response.output_text.delta",
        eventKeys: ["delta", "type"],
      }),
    );
  });

  it.each([
    ["response.failed", "failed"],
    ["response.incomplete", "incomplete"],
    ["response.cancelled", "cancelled"],
  ] as const)("keeps %s as a distinct terminal outcome", (type, status) => {
    let state = reduceResponseEvent(createResponseProjection(), {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_terminal", status: "queued", output: [] },
    }).state;
    const result = reduceResponseEvent(state, {
      type,
      sequence_number: 1,
      response: { id: "resp_terminal", status, output: [] },
    });
    state = result.state;

    expect(state.status).toBe(status);
    expect(result.normalized).toContainEqual(
      expect.objectContaining({ kind: "terminal", status }),
    );
  });

  it("accepts an unsequenced terminal event without rewinding the cursor", () => {
    let state = reduceResponseEvent(createResponseProjection(), {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_unsequenced_terminal", status: "in_progress", output: [] },
    }).state;
    state = reduceResponseEvent(state, {
      type: "response.in_progress",
      sequence_number: 1,
      response: { id: "resp_unsequenced_terminal", status: "in_progress", output: [] },
    }).state;

    const result = reduceResponseEvent(state, {
      type: "response.failed",
      response: { id: "resp_unsequenced_terminal", status: "failed", output: [] },
    });

    expect(result.unsequenced).toBe(true);
    expect(result.state.lastSequenceNumber).toBe(1);
    expect(result.normalized).toContainEqual(
      expect.objectContaining({
        kind: "terminal",
        sequenceNumber: 1,
        status: "failed",
      }),
    );
  });

  it("preserves a failed hosted-tool item separately from run failure", () => {
    let state = reduceResponseEvent(createResponseProjection(), {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_tool", status: "queued", output: [] },
    }).state;
    const result = reduceResponseEvent(state, {
      type: "response.output_item.done",
      sequence_number: 1,
      output_index: 0,
      item: {
        id: "tool_1",
        type: "code_interpreter_call",
        status: "failed",
      },
    });
    state = result.state;

    expect(state.status).toBe("queued");
    expect(state.tools.tool_1).toMatchObject({
      toolType: "code_interpreter_call",
      status: "failed",
    });
  });
});
