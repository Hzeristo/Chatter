import type { ResponseInputItem } from "openai/resources/responses/responses";

import type {
  JournalRecord,
  OpenAINativeItem,
} from "@mas-chat/protocol";

import { ReplayHistoryError } from "./errors.js";

/**
 * Builds the native Responses input history from completed local turns.
 * Nothing is flattened: encrypted reasoning, phases, and hosted-tool items
 * remain byte-for-byte equivalent to their parsed JSON representation.
 */
export function buildReplayHistory(records: JournalRecord[]): ResponseInputItem[] {
  const history: OpenAINativeItem[] = [];
  let activeTurnId: string | undefined;
  let pendingInput: OpenAINativeItem[] = [];

  for (const record of records) {
    switch (record.kind) {
      case "session.created":
      case "response.event":
        break;
      case "turn.input":
        if (activeTurnId !== undefined) {
          throw new ReplayHistoryError(
            `Turn ${record.turnId} started before ${activeTurnId} was finalized`,
          );
        }
        activeTurnId = record.turnId;
        pendingInput = record.items;
        break;
      case "turn.output":
        if (activeTurnId !== record.turnId) {
          throw new ReplayHistoryError(
            `Output for ${record.turnId} does not match active turn ${String(activeTurnId)}`,
          );
        }
        history.push(...pendingInput, ...record.items);
        activeTurnId = undefined;
        pendingInput = [];
        break;
      case "turn.aborted":
        if (activeTurnId !== record.turnId) {
          throw new ReplayHistoryError(
            `Abort for ${record.turnId} does not match active turn ${String(activeTurnId)}`,
          );
        }
        activeTurnId = undefined;
        pendingInput = [];
        break;
    }
  }

  if (activeTurnId !== undefined) {
    throw new ReplayHistoryError(
      `Cannot build next-turn history while ${activeTurnId} is still active`,
    );
  }

  return history as ResponseInputItem[];
}
