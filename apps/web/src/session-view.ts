import type {
  JournalRecord,
  OpenAINativeItem,
  RunStatus,
  SessionForkMetadata,
  SessionMetadata,
} from "@mas-chat/protocol";
import {
  buildTurnPath,
  createResponseProjection,
  reduceResponseEvent,
  resolveTurns,
  type ResolvedTurn,
} from "@mas-chat/runtime";

export type SessionRecovery = "attachable" | "running";

export interface TurnVersionView {
  headTurnId: string;
  status: RunStatus;
  turnId: string;
}

export interface SessionMessageView {
  id: string;
  kind?: "status";
  partial?: boolean;
  phase?: "commentary" | "final_answer" | "unknown";
  role: "user" | "assistant";
  text: string;
  turnId: string;
  turnStatus?: RunStatus;
  versions?: TurnVersionView[];
  versionIndex?: number;
  retryable?: boolean;
  forkable?: boolean;
}

export interface SessionView {
  canContinue: boolean;
  fork?: SessionForkMetadata;
  headTurnId: string | null;
  lastSequenceNumber: number;
  messages: SessionMessageView[];
  recovery?: SessionRecovery;
  responseId?: string;
  sessionId: string;
  status: RunStatus;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textValue).join("");
  }
  if (isObject(value)) {
    return stringValue(value.text) ?? "";
  }
  return "";
}

function itemText(item: OpenAINativeItem): string {
  return textValue(item.content);
}

function phaseValue(
  item: OpenAINativeItem,
): SessionMessageView["phase"] {
  const phase = stringValue(item.phase);
  return phase === "commentary" || phase === "final_answer"
    ? phase
    : "unknown";
}

function turnAssistantItems(
  turn: ResolvedTurn,
  records: JournalRecord[],
): Array<{ id: string; phase: SessionMessageView["phase"]; text: string }> {
  if (turn.output !== undefined) {
    return turn.output.items.flatMap((item, index) => {
      if (item.type !== "message") {
        return [];
      }
      const text = itemText(item);
      return text === ""
        ? []
        : [{
            id: stringValue(item.id) ?? `${turn.input.turnId}:assistant:${index}`,
            phase: phaseValue(item),
            text,
          }];
    });
  }

  let projection = createResponseProjection();
  for (const record of records) {
    if (record.kind === "response.event" && record.turnId === turn.input.turnId) {
      projection = reduceResponseEvent(projection, record.event).state;
    }
  }
  return Object.values(projection.assistantMessages)
    .sort((left, right) => left.outputIndex - right.outputIndex)
    .filter((message) => message.text !== "")
    .map((message) => ({
      id: message.id,
      phase: message.phase,
      text: message.text,
    }));
}

function sameParent(left: ResolvedTurn, right: ResolvedTurn): boolean {
  return left.parentTurnId === right.parentTurnId;
}

function latestDescendantHead(
  rootTurnId: string,
  visibleTurns: ResolvedTurn[],
): string {
  const byId = new Map(
    visibleTurns.map((turn) => [turn.input.turnId, turn] as const),
  );
  let latest = rootTurnId;
  for (const candidate of visibleTurns) {
    let current: ResolvedTurn | undefined = candidate;
    while (current !== undefined) {
      if (current.input.turnId === rootTurnId) {
        latest = candidate.input.turnId;
        break;
      }
      current =
        current.parentTurnId === null
          ? undefined
          : byId.get(current.parentTurnId);
    }
  }
  return latest;
}

function hiddenTransportAttempts(turns: ResolvedTurn[]): Set<string> {
  return new Set(
    turns.flatMap((turn) =>
      turn.input.lineage?.fork?.kind === "transport_fallback"
        ? [turn.input.lineage.fork.sourceTurnId]
        : [],
    ),
  );
}

function statusNotice(status: RunStatus): string | undefined {
  switch (status) {
    case "queued":
    case "in_progress":
      return "响应尚未完成";
    case "failed":
      return "响应生成失败";
    case "incomplete":
      return "响应未完成";
    case "cancelled":
      return "响应已停止";
    default:
      return undefined;
  }
}

function userText(turn: ResolvedTurn): string {
  return turn.input.items
    .filter((item) => stringValue(item.role) === "user")
    .map(itemText)
    .join("\n");
}

export function createSessionView(
  sessionId: string,
  metadata: SessionMetadata,
  records: JournalRecord[],
  selectedHeadTurnId: string | undefined,
  locallyActive: boolean,
): SessionView {
  const turns = resolveTurns(records);
  const hidden = hiddenTransportAttempts(turns);
  const visibleTurns = turns.filter((turn) => !hidden.has(turn.input.turnId));
  const defaultHead = visibleTurns.at(-1)?.input.turnId ?? null;
  const headTurnId = selectedHeadTurnId ?? defaultHead;
  if (
    headTurnId !== null &&
    !visibleTurns.some((turn) => turn.input.turnId === headTurnId)
  ) {
    throw new Error(`Unknown visible turn ${headTurnId}`);
  }

  const path =
    headTurnId === null
      ? []
      : buildTurnPath(records, headTurnId).filter(
          (turn) => !hidden.has(turn.input.turnId),
        );
  const messages: SessionMessageView[] = [];

  for (const turn of path) {
    const siblings = visibleTurns.filter((candidate) => sameParent(candidate, turn));
    const versions = siblings.map((sibling) => ({
      turnId: sibling.input.turnId,
      headTurnId: latestDescendantHead(sibling.input.turnId, visibleTurns),
      status: sibling.status,
    }));
    const text = userText(turn);
    const userMessage: SessionMessageView = {
      id: `${turn.input.turnId}:user`,
      role: "user",
      text,
      turnId: turn.input.turnId,
      turnStatus: turn.status,
      versions,
      versionIndex: versions.findIndex(
        (version) => version.turnId === turn.input.turnId,
      ),
      retryable:
        metadata.activeTurnId === undefined ||
        (!locallyActive && metadata.activeTurnId === turn.input.turnId),
      forkable:
        metadata.activeTurnId === undefined && turn.status === "completed",
    };
    messages.push(userMessage);

    const partial = turn.status !== "completed";
    for (const assistant of turnAssistantItems(turn, records)) {
      const message: SessionMessageView = {
        id: assistant.id,
        role: "assistant",
        text: assistant.text,
        turnId: turn.input.turnId,
        ...(partial ? { partial: true } : {}),
      };
      if (assistant.phase !== undefined) {
        message.phase = assistant.phase;
      }
      messages.push(message);
    }

    const notice = statusNotice(turn.status);
    if (notice !== undefined) {
      messages.push({
        id: `${turn.input.turnId}:status`,
        kind: "status",
        role: "assistant",
        text: notice,
        turnId: turn.input.turnId,
        turnStatus: turn.status,
      });
    }
  }

  const head = path.at(-1);
  const status = head?.status ?? "idle";
  const activeInput =
    metadata.activeTurnId === undefined
      ? undefined
      : turns.find((turn) => turn.input.turnId === metadata.activeTurnId)?.input;
  const recovery: SessionRecovery | undefined =
    metadata.activeTurnId === undefined
      ? undefined
      : locallyActive
        ? "running"
        : metadata.responseId !== undefined &&
            activeInput?.configuration.background
          ? "attachable"
          : undefined;
  const canSupersedeActiveHead =
    recovery === "attachable" &&
    head?.input.turnId === metadata.activeTurnId;

  return {
    sessionId,
    headTurnId,
    status,
    lastSequenceNumber: metadata.lastSequenceNumber,
    messages,
    canContinue:
      canSupersedeActiveHead ||
      (metadata.activeTurnId === undefined &&
        head?.status !== "queued" &&
        head?.status !== "in_progress"),
    ...(metadata.fork === undefined ? {} : { fork: metadata.fork }),
    ...(metadata.responseId === undefined
      ? {}
      : { responseId: metadata.responseId }),
    ...(recovery === undefined ? {} : { recovery }),
  };
}
