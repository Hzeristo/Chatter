import { describe, expect, it } from "vitest";

import type { NormalizedEvent } from "@mas-chat/protocol";

import { renderEvent, type OutputWriter } from "./render.js";

describe("CLI event renderer", () => {
  it("keeps commentary and final-answer channels separate", () => {
    let output = "";
    let progress = "";
    const writer: OutputWriter = {
      write: (text) => {
        output += text;
      },
      error: (text) => {
        progress += text;
      },
    };
    const events: NormalizedEvent[] = [
      {
        kind: "assistant_text",
        sourceType: "response.output_text.delta",
        sequenceNumber: 0,
        itemId: "commentary",
        outputIndex: 0,
        phase: "commentary",
        delta: "Checking...",
      },
      {
        kind: "assistant_text",
        sourceType: "response.output_text.delta",
        sequenceNumber: 1,
        itemId: "final",
        outputIndex: 1,
        phase: "final_answer",
        delta: "Done.",
      },
    ];

    for (const event of events) {
      renderEvent(event, writer);
    }

    expect(progress).toBe("Checking...");
    expect(output).toBe("Done.");
  });
});
