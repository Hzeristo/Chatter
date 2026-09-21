import { describe, expect, it } from "vitest";

import type { ResponseInputItem } from "openai/resources/responses/responses";

import {
  buildSessionInstructions,
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
    expect(request.instructions).toContain(
      "Continue the established conversation naturally",
    );
    expect(request.instructions).not.toContain("Help the user complete");
    expect(snapshotRunConfiguration(request)).toMatchObject({
      model: "gpt-6-astra",
      store: false,
    });
  });

  it("applies configurable inference settings without unlocking stateless streaming", () => {
    const request = buildStatelessResponseRequest(
      [],
      [{ role: "user", content: "Question" }] as ResponseInputItem[],
      {
        model: "compatible-model",
        reasoningEffort: "high",
        reasoningSummary: "detailed",
        textVerbosity: "low",
        enableWebSearch: false,
        enableCodeInterpreter: true,
      },
    );

    expect(request).toMatchObject({
      model: "compatible-model",
      background: true,
      stream: true,
      store: false,
      reasoning: {
        effort: "high",
        summary: "detailed",
        context: "all_turns",
      },
      text: { verbosity: "low" },
      tools: [{ type: "code_interpreter" }],
    });
    expect(request.include).toEqual([
      "reasoning.encrypted_content",
      "code_interpreter_call.outputs",
    ]);
  });

  it("can build an explicit foreground fallback while keeping local state authoritative", () => {
    const request = buildStatelessResponseRequest(
      [],
      [{ role: "user", content: "Question" }] as ResponseInputItem[],
      {},
      false,
    );

    expect(request.background).toBeUndefined();
    expect(request.stream).toBe(true);
    expect(request.store).toBe(false);
    expect(snapshotRunConfiguration(request).background).toBe(false);
  });

  it("can omit both prompt layers for a native model baseline", () => {
    const request = buildStatelessResponseRequest(
      [],
      [{ role: "user", content: "Question" }] as ResponseInputItem[],
      { developerPrompt: null },
    );

    expect(request).not.toHaveProperty("instructions");
    expect(request.input).toEqual([{ role: "user", content: "Question" }]);
    expect(snapshotRunConfiguration(request)).not.toHaveProperty(
      "instructions",
    );
  });

  it("combines the base prompt and continuation cue only on the first request", () => {
    const request = buildStatelessResponseRequest(
      [],
      [{ role: "user", content: "Question" }] as ResponseInputItem[],
      {
        developerPrompt: "Base behavior",
        sessionFollowingInstruction: "Continue this session",
      },
    );

    expect(request.input).toEqual([{ role: "user", content: "Question" }]);
    expect(request.instructions).toBe(
      "Base behavior\n\nContinue this session",
    );
    expect(snapshotRunConfiguration(request).instructions).toBe(
      "Base behavior\n\nContinue this session",
    );
  });

  it("uses only one continuation cue after the first request", () => {
    const first = buildSessionInstructions(
      [],
      {
        developerPrompt: "Base behavior",
        sessionFollowingInstruction: "Continue this session",
      },
    );
    const second = buildSessionInstructions(
      [{ role: "user", content: "First" }] as ResponseInputItem[],
      {
        developerPrompt: "Base behavior",
        sessionFollowingInstruction: "Continue this session",
      },
    );

    expect(first).toBe("Base behavior\n\nContinue this session");
    expect(second).toBe("Continue this session");
  });

  it("can disable the continuation cue while retaining the first-turn base prompt", () => {
    const request = buildStatelessResponseRequest(
      [],
      [{ role: "user", content: "Question" }] as ResponseInputItem[],
      {
        developerPrompt: "Base behavior",
        sessionFollowingInstruction: null,
      },
    );

    expect(request.instructions).toBe("Base behavior");
    expect(
      buildSessionInstructions(
        [{ role: "user", content: "First" }] as ResponseInputItem[],
        {
          developerPrompt: "Base behavior",
          sessionFollowingInstruction: null,
        },
      ),
    ).toBeUndefined();
  });
});
