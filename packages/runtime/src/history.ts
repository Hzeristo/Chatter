import type { ResponseInputItem } from "openai/resources/responses/responses";

import type {
  JournalRecord,
  OpenAINativeItem,
  RunStatus,
  TurnAbortedRecord,
  TurnFailedRecord,
  TurnInputRecord,
  TurnOutputRecord,
} from "@mas-chat/protocol";

import { ReplayHistoryError } from "./errors.js";
import { statusFromResponseEvent } from "./reducer.js";

export interface ResolvedTurn {
  failure?: TurnAbortedRecord | TurnFailedRecord;
  input: TurnInputRecord;
  output?: TurnOutputRecord;
  parentTurnId: string | null;
  status: RunStatus;
}

/**
 * Resolves additive branch metadata while preserving compatibility with old
 * linear journals. Legacy turns are parented to the latest completed turn.
 */
export function resolveTurns(records: JournalRecord[]): ResolvedTurn[] {
  const turns: ResolvedTurn[] = [];
  const byId = new Map<string, ResolvedTurn>();
  let latestCompletedTurnId: string | null = null;

  for (const record of records) {
    switch (record.kind) {
      case "session.created":
        break;
      case "turn.input": {
        if (byId.has(record.turnId)) {
          throw new ReplayHistoryError(`Turn ${record.turnId} has duplicate input`);
        }
        const parentTurnId =
          record.lineage === undefined
            ? latestCompletedTurnId
            : record.lineage.parentTurnId;
        if (parentTurnId !== null && !byId.has(parentTurnId)) {
          throw new ReplayHistoryError(
            `Turn ${record.turnId} references unknown parent ${parentTurnId}`,
          );
        }
        const turn: ResolvedTurn = {
          input: record,
          parentTurnId,
          status: "queued",
        };
        turns.push(turn);
        byId.set(record.turnId, turn);
        break;
      }
      case "response.event": {
        const turn = byId.get(record.turnId);
        if (turn === undefined) {
          throw new ReplayHistoryError(
            `Response event references unknown turn ${record.turnId}`,
          );
        }
        turn.status = statusFromResponseEvent(record.event) ?? turn.status;
        break;
      }
      case "turn.output": {
        const turn = byId.get(record.turnId);
        if (turn === undefined) {
          throw new ReplayHistoryError(
            `Output references unknown turn ${record.turnId}`,
          );
        }
        turn.output = record;
        turn.status = record.status;
        if (record.status === "completed") {
          latestCompletedTurnId = record.turnId;
        }
        break;
      }
      case "turn.aborted":
      case "turn.failed": {
        const turn = byId.get(record.turnId);
        if (turn === undefined) {
          throw new ReplayHistoryError(
            `Failure references unknown turn ${record.turnId}`,
          );
        }
        turn.failure = record;
        turn.status = "failed";
        break;
      }
    }
  }

  return turns;
}

export function latestCompletedTurnId(
  records: JournalRecord[],
): string | null {
  return (
    resolveTurns(records).findLast(
      (turn) => turn.output?.status === "completed",
    )?.input.turnId ?? null
  );
}

export function buildTurnPath(
  records: JournalRecord[],
  headTurnId: string,
): ResolvedTurn[] {
  const turns = resolveTurns(records);
  const byId = new Map(turns.map((turn) => [turn.input.turnId, turn]));
  const reversePath: ResolvedTurn[] = [];
  const visited = new Set<string>();
  let turnId: string | null = headTurnId;

  while (turnId !== null) {
    if (visited.has(turnId)) {
      throw new ReplayHistoryError(`Turn lineage contains a cycle at ${turnId}`);
    }
    visited.add(turnId);
    const turn = byId.get(turnId);
    if (turn === undefined) {
      throw new ReplayHistoryError(`Unknown turn ${turnId}`);
    }
    reversePath.push(turn);
    turnId = turn.parentTurnId;
  }

  return reversePath.reverse();
}

/**
 * Builds native Responses history for exactly one completed ancestry path.
 * Failed, incomplete, cancelled, and active output is never replayed.
 */
export function buildReplayHistory(
  records: JournalRecord[],
  headTurnId?: string | null,
): ResponseInputItem[] {
  const turns = resolveTurns(records);
  let resolvedHead = headTurnId;

  if (resolvedHead === undefined) {
    const latest = turns.at(-1);
    if (
      latest !== undefined &&
      (latest.status === "queued" || latest.status === "in_progress")
    ) {
      throw new ReplayHistoryError(
        `Cannot build next-turn history while ${latest.input.turnId} is still active`,
      );
    }
    resolvedHead =
      latest?.status === "completed"
        ? latest.input.turnId
        : (latest?.parentTurnId ?? null);
  }

  if (resolvedHead === null) {
    return [];
  }

  const history: OpenAINativeItem[] = [];
  for (const turn of buildTurnPath(records, resolvedHead)) {
    if (turn.status === "queued" || turn.status === "in_progress") {
      throw new ReplayHistoryError(
        `Turn ${turn.input.turnId} is still active and cannot be replayed`,
      );
    }
    history.push(...turn.input.items);
    if (turn.status === "completed") {
      if (turn.output?.status !== "completed") {
        throw new ReplayHistoryError(
          `Turn ${turn.input.turnId} has no committed completed output`,
        );
      }
      history.push(...turn.output.items);
    }
  }

  return history as ResponseInputItem[];
}
