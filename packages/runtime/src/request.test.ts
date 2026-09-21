import { describe, expect, it } from "vitest";

import type { ResponseInputItem } from "openai/resources/responses/responses";

import {
  buildStatelessResponseRequest,
  snapshotRunConfiguration,
} from "./request.js";

describe("stateless Responses request", () => {
  it("hard-codes local replay semantics and never chains a stored response", () => {
    const history = [
      { role: "user", content: "First question" },
      {
        id: "rs_1",
        type: "reasoning",
        encrypted_content: "opaque",
        summary: [],
      },
    ] as ResponseInputItem[];
    const next = [{ role: "user", content: "Follow-up" }] as ResponseInputItem[];

    const request = buildStatelessResponseRequest(history, next);

    expect(request.store).toBe(false);
    expect(request.background).toBe(true);
    expect(request.stream).toBe(true);
    expect(request).not.toHaveProperty("previous_response_id");
    expect(request.input).toEqual([...history, ...next]);
    expect(request.reasoning).toEqual({
      effort: "max",
      summary: "auto",
      context: "all_turns",
    });
    expect(request.text).toEqual({ verbosity: "medium" });
    expect(request.include).toContain("reasoning.encrypted_content");
    expect(snapshotRunConfiguration(request)).toMatchObject({
      model: "gpt-6-astra",
      store: false,
    });
  });
});
