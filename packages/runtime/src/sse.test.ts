import { describe, expect, it } from "vitest";

import { parseSseJson, SseProtocolError } from "./sse.js";

async function* chunks(values: Array<string | Uint8Array>) {
  yield* values;
}

async function collect(values: Array<string | Uint8Array>) {
  const events = [];
  for await (const event of parseSseJson(chunks(values))) {
    events.push(event);
  }
  return events;
}

describe("SSE parser", () => {
  it("handles CRLF, split frames, comments, and event-name fallback", async () => {
    const events = await collect([
      ": keep-alive\r\n\r\nevent: response.created\r\n",
      'data: {"sequence_number":0,"response":{"id":"resp_1"}}\r\n\r\n',
      'data: {"type":"response.in_progress","sequence_number":1}\n\n',
      "data: [DONE]\n\n",
      'data: {"type":"must.not.be.read","sequence_number":2}\n\n',
    ]);

    expect(events).toEqual([
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp_1" },
      },
      { type: "response.in_progress", sequence_number: 1 },
    ]);
  });

  it("preserves UTF-8 characters split across byte chunks", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"response.output_text.delta","sequence_number":2,"delta":"道路"}\n\n',
    );
    const split = bytes.indexOf(0xe9) + 1;
    const events = await collect([bytes.slice(0, split), bytes.slice(split)]);

    expect(events[0]?.delta).toBe("道路");
  });

  it("rejects malformed JSON instead of silently dropping an event", async () => {
    await expect(collect(["data: {broken}\n\n"])).rejects.toBeInstanceOf(
      SseProtocolError,
    );
  });
});
