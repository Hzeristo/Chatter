import type {
  AssistantMessageProjection,
  JsonObject,
  JsonValue,
  NormalizedEvent,
  ReasoningProjection,
  ResponseProjection,
  RunStatus,
  TerminalStatus,
  ToolProjection,
} from "@mas-chat/protocol";

import { ResponseIdentityError, ResponseSequenceError } from "./errors.js";

export interface ReduceResult {
  duplicate: boolean;
  normalized: NormalizedEvent[];
  state: ResponseProjection;
  /** True when the provider event was handled without advancing its cursor. */
  unsequenced?: boolean;
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function arrayValue(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function responseIdFromEvent(event: JsonObject): string | undefined {
  const direct = stringValue(event.response_id);
  if (direct !== undefined) {
    return direct;
  }
  return stringValue(objectValue(event.response)?.id);
}

function phaseFromItem(
  item: JsonObject,
): AssistantMessageProjection["phase"] {
  const phase = stringValue(item.phase);
  return phase === "commentary" || phase === "final_answer"
    ? phase
    : "unknown";
}

function messageStatusFromItem(
  item: JsonObject,
): AssistantMessageProjection["status"] {
  const status = stringValue(item.status);
  return status === "completed" || status === "incomplete"
    ? status
    : "in_progress";
}

function itemText(item: JsonObject): string {
  return arrayValue(item.content)
    .map(objectValue)
    .filter((part): part is JsonObject => part !== undefined)
    .map((part) => stringValue(part.text) ?? "")
    .join("");
}

function itemAnnotations(item: JsonObject): JsonObject[] {
  return arrayValue(item.content)
    .map(objectValue)
    .filter((part): part is JsonObject => part !== undefined)
    .flatMap((part) => arrayValue(part.annotations))
    .map(objectValue)
    .filter((annotation): annotation is JsonObject => annotation !== undefined);
}

function reasoningSummary(item: JsonObject): string {
  return arrayValue(item.summary)
    .map(objectValue)
    .filter((part): part is JsonObject => part !== undefined)
    .map((part) => stringValue(part.text) ?? "")
    .join("");
}

function toolStatus(value: JsonValue | undefined): ToolProjection["status"] {
  const status = stringValue(value);
  if (
    status === "searching" ||
    status === "completed" ||
    status === "failed"
  ) {
    return status;
  }
  return "in_progress";
}

function isToolItemType(type: string): boolean {
  return (
    type.endsWith("_call") ||
    type === "mcp_call" ||
    type === "image_generation_call"
  );
}

function statusFromTerminalType(type: string): TerminalStatus | undefined {
  switch (type) {
    case "response.completed":
      return "completed";
    case "response.failed":
      return "failed";
    case "response.incomplete":
      return "incomplete";
    case "response.cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

function canHandleWithoutCursor(type: string): boolean {
  return (
    type === "response.created" ||
    type === "response.queued" ||
    type === "response.in_progress" ||
    statusFromTerminalType(type) !== undefined
  );
}

function cloneProjection(state: ResponseProjection): ResponseProjection {
  const clone: ResponseProjection = {
    status: state.status,
    lastSequenceNumber: state.lastSequenceNumber,
    assistantMessages: { ...state.assistantMessages },
    reasoning: { ...state.reasoning },
    tools: { ...state.tools },
  };
  if (state.responseId !== undefined) {
    clone.responseId = state.responseId;
  }
  if (state.usage !== undefined) {
    clone.usage = state.usage;
  }
  return clone;
}

export function createResponseProjection(): ResponseProjection {
  return {
    status: "idle",
    lastSequenceNumber: -1,
    assistantMessages: {},
    reasoning: {},
    tools: {},
  };
}

export function reduceResponseEvent(
  state: ResponseProjection,
  event: JsonObject,
): ReduceResult {
  const type = stringValue(event.type) ?? "unknown";
  const sequenceNumber = numberValue(event.sequence_number);
  const unsequenced =
    sequenceNumber === undefined && canHandleWithoutCursor(type);
  if (
    (sequenceNumber === undefined && !unsequenced) ||
    (sequenceNumber !== undefined && sequenceNumber < 0)
  ) {
    throw new ResponseSequenceError(state.lastSequenceNumber + 1, sequenceNumber, {
      eventType: type,
      eventKeys: Object.keys(event).sort(),
    });
  }
  if (sequenceNumber !== undefined && sequenceNumber <= state.lastSequenceNumber) {
    return { state, normalized: [], duplicate: true };
  }

  const incomingResponseId = responseIdFromEvent(event);
  if (
    state.responseId !== undefined &&
    incomingResponseId !== undefined &&
    incomingResponseId !== state.responseId
  ) {
    throw new ResponseIdentityError(state.responseId, incomingResponseId);
  }

  const next = cloneProjection(state);
  if (sequenceNumber !== undefined) {
    next.lastSequenceNumber = sequenceNumber;
  }
  if (incomingResponseId !== undefined) {
    next.responseId = incomingResponseId;
  }
  const base = {
    sequenceNumber: sequenceNumber ?? Math.max(state.lastSequenceNumber, 0),
    sourceType: type,
    ...(next.responseId === undefined ? {} : { responseId: next.responseId }),
  };
  const normalized: NormalizedEvent[] = [];

  if (type === "response.created" || type === "response.queued") {
    next.status = "queued";
    normalized.push({ ...base, kind: "lifecycle", status: "queued" });
  } else if (type === "response.in_progress") {
    next.status = "in_progress";
    normalized.push({ ...base, kind: "lifecycle", status: "in_progress" });
  } else if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = objectValue(event.item);
    const outputIndex = numberValue(event.output_index) ?? -1;
    const itemId = item === undefined ? undefined : stringValue(item.id);
    const itemType = item === undefined ? undefined : stringValue(item.type);

    if (item !== undefined && itemId !== undefined && itemType === "message") {
      const existing = next.assistantMessages[itemId];
      const projection: AssistantMessageProjection = {
        id: itemId,
        outputIndex,
        phase: phaseFromItem(item),
        status: messageStatusFromItem(item),
        text:
          type === "response.output_item.done"
            ? itemText(item)
            : (existing?.text ?? ""),
        annotations:
          type === "response.output_item.done"
            ? itemAnnotations(item)
            : (existing?.annotations ?? []),
      };
      next.assistantMessages[itemId] = projection;
      normalized.push({
        ...base,
        kind: "assistant_text",
        itemId,
        outputIndex,
        phase: projection.phase,
      });
    } else if (
      item !== undefined &&
      itemId !== undefined &&
      itemType === "reasoning"
    ) {
      const projection: ReasoningProjection = {
        id: itemId,
        outputIndex,
        summary:
          type === "response.output_item.done"
            ? reasoningSummary(item)
            : (next.reasoning[itemId]?.summary ?? ""),
      };
      next.reasoning[itemId] = projection;
      normalized.push({ ...base, kind: "reasoning", itemId, outputIndex });
    } else if (
      item !== undefined &&
      itemId !== undefined &&
      itemType !== undefined &&
      isToolItemType(itemType)
    ) {
      const projection: ToolProjection = {
        id: itemId,
        outputIndex,
        toolType: itemType,
        status: toolStatus(item.status),
      };
      const action = objectValue(item.action);
      if (action !== undefined) {
        projection.action = action;
      }
      next.tools[itemId] = projection;
      normalized.push({
        ...base,
        kind: "tool",
        itemId,
        outputIndex,
        toolType: itemType,
        status: projection.status,
      });
    } else {
      normalized.push({ ...base, kind: "unknown", raw: event });
    }
  } else if (type === "response.reasoning_summary_text.delta") {
    const itemId = stringValue(event.item_id) ?? "unknown";
    const outputIndex = numberValue(event.output_index) ?? -1;
    const delta = stringValue(event.delta) ?? "";
    const existing = next.reasoning[itemId];
    next.reasoning[itemId] = {
      id: itemId,
      outputIndex,
      summary: `${existing?.summary ?? ""}${delta}`,
    };
    normalized.push({
      ...base,
      kind: "reasoning",
      itemId,
      outputIndex,
      delta,
    });
  } else if (type === "response.reasoning_summary_text.done") {
    const itemId = stringValue(event.item_id) ?? "unknown";
    const outputIndex = numberValue(event.output_index) ?? -1;
    normalized.push({ ...base, kind: "reasoning", itemId, outputIndex });
  } else if (type === "response.output_text.delta") {
    const itemId = stringValue(event.item_id) ?? "unknown";
    const outputIndex = numberValue(event.output_index) ?? -1;
    const delta = stringValue(event.delta) ?? "";
    const existing = next.assistantMessages[itemId];
    const phase = existing?.phase ?? "unknown";
    next.assistantMessages[itemId] = {
      id: itemId,
      outputIndex,
      phase,
      status: "in_progress",
      text: `${existing?.text ?? ""}${delta}`,
      annotations: existing?.annotations ?? [],
    };
    normalized.push({
      ...base,
      kind: "assistant_text",
      itemId,
      outputIndex,
      phase,
      delta,
    });
  } else if (type === "response.output_text.annotation.added") {
    const itemId = stringValue(event.item_id) ?? "unknown";
    const outputIndex = numberValue(event.output_index) ?? -1;
    const annotation = objectValue(event.annotation) ?? {};
    const existing = next.assistantMessages[itemId];
    next.assistantMessages[itemId] = {
      id: itemId,
      outputIndex,
      phase: existing?.phase ?? "unknown",
      status: existing?.status ?? "in_progress",
      text: existing?.text ?? "",
      annotations: [...(existing?.annotations ?? []), annotation],
    };
    normalized.push({
      ...base,
      kind: "annotation",
      itemId,
      outputIndex,
      annotation,
    });
  } else if (type.startsWith("response.web_search_call.")) {
    const itemId = stringValue(event.item_id) ?? "unknown";
    const outputIndex = numberValue(event.output_index) ?? -1;
    const status = type.endsWith(".completed")
      ? "completed"
      : type.endsWith(".searching")
        ? "searching"
        : "in_progress";
    const existing = next.tools[itemId];
    next.tools[itemId] = {
      id: itemId,
      outputIndex,
      toolType: existing?.toolType ?? "web_search_call",
      status,
      ...(existing?.action === undefined ? {} : { action: existing.action }),
    };
    normalized.push({
      ...base,
      kind: "tool",
      itemId,
      outputIndex,
      toolType: "web_search_call",
      status,
    });
  } else {
    const terminalStatus = statusFromTerminalType(type);
    if (terminalStatus !== undefined) {
      next.status = terminalStatus;
      const response = objectValue(event.response);
      const usage = response === undefined ? undefined : objectValue(response.usage);
      if (usage !== undefined) {
        next.usage = usage;
      }
      normalized.push({
        ...base,
        kind: "terminal",
        status: terminalStatus,
        ...(usage === undefined ? {} : { usage }),
      });
    } else if (type === "error") {
      normalized.push({
        ...base,
        kind: "error",
        error: objectValue(event.error) ?? event,
      });
    } else {
      normalized.push({ ...base, kind: "unknown", raw: event });
    }
  }

  return {
    state: next,
    normalized,
    duplicate: false,
    ...(unsequenced ? { unsequenced: true } : {}),
  };
}

export function statusFromResponseEvent(event: JsonObject): RunStatus | undefined {
  const type = stringValue(event.type);
  if (type === "response.created" || type === "response.queued") {
    return "queued";
  }
  if (type === "response.in_progress") {
    return "in_progress";
  }
  return type === undefined ? undefined : statusFromTerminalType(type);
}
