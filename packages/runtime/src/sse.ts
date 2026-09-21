import type { JsonObject } from "@mas-chat/protocol";

export class SseProtocolError extends Error {
  readonly payload: string;

  constructor(message: string, payload: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SseProtocolError";
    this.payload = payload;
  }
}

interface SseFrame {
  data: string;
  event?: string;
}

function parseFrame(block: string): SseFrame | undefined {
  const data: string[] = [];
  let event: string | undefined;

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }

  if (data.length === 0) {
    return undefined;
  }
  return event === undefined
    ? { data: data.join("\n") }
    : { event, data: data.join("\n") };
}

function parseJsonFrame(frame: SseFrame): JsonObject | undefined {
  if (frame.data === "[DONE]") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch (error) {
    throw new SseProtocolError("SSE data is not valid JSON", frame.data, error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SseProtocolError("SSE JSON payload must be an object", frame.data);
  }

  const event = parsed as JsonObject;
  if (event.type === undefined && frame.event !== undefined) {
    event.type = frame.event;
  }
  return event;
}

/** Parse an OpenAI-style SSE body without assuming chunk or UTF-8 boundaries. */
export async function* parseSseJson(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<JsonObject> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of source) {
    buffer +=
      typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replaceAll("\r\n", "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseFrame(block);
      if (frame !== undefined) {
        const event = parseJsonFrame(frame);
        if (event === undefined) {
          return;
        }
        yield event;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  buffer = buffer.replaceAll("\r\n", "\n");
  if (buffer.trim() !== "") {
    const frame = parseFrame(buffer);
    if (frame !== undefined) {
      const event = parseJsonFrame(frame);
      if (event !== undefined) {
        yield event;
      }
    }
  }
}
