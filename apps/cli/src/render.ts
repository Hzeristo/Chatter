import type { NormalizedEvent } from "@mas-chat/protocol";

export interface OutputWriter {
  error(text: string): void;
  write(text: string): void;
}

export const consoleWriter: OutputWriter = {
  error(text) {
    process.stderr.write(text);
  },
  write(text) {
    process.stdout.write(text);
  },
};

export function renderEvent(event: NormalizedEvent, writer: OutputWriter): void {
  switch (event.kind) {
    case "assistant_text":
      if (event.delta === undefined) {
        return;
      }
      if (event.phase === "final_answer") {
        writer.write(event.delta);
      } else {
        writer.error(event.delta);
      }
      return;
    case "reasoning":
      if (event.delta !== undefined) {
        writer.error(event.delta);
      }
      return;
    case "tool":
      writer.error(`\n[${event.toolType}: ${event.status}]\n`);
      return;
    case "terminal":
      writer.write("\n");
      if (event.status !== "completed") {
        writer.error(`[response ${event.status}]\n`);
      }
      return;
    case "error":
      writer.error(`\n[stream error: ${JSON.stringify(event.error)}]\n`);
      return;
    case "annotation":
    case "lifecycle":
    case "unknown":
      return;
  }
}
