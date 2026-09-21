export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * An item in the native Responses input/output schema. The runtime keeps the
 * object intact so it can be replayed to OpenAI without flattening it into a
 * human-oriented transcript.
 */
export interface OpenAINativeItem extends JsonObject {
  type?: string;
}

export const JOURNAL_SCHEMA_VERSION = 1 as const;

export type RunStatus =
  | "idle"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "incomplete"
  | "cancelled";

export type TerminalStatus = Extract<
  RunStatus,
  "completed" | "failed" | "incomplete" | "cancelled"
>;

export interface RunConfigurationSnapshot extends JsonObject {
  background: boolean;
  include: JsonValue[];
  instructions: string;
  model: string;
  reasoning: JsonObject;
  store: false;
  stream: true;
  text: JsonObject;
  tools: JsonObject[];
}

interface JournalRecordBase {
  at: string;
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  sessionId: string;
}

export interface SessionCreatedRecord extends JournalRecordBase {
  kind: "session.created";
}

export interface TurnInputRecord extends JournalRecordBase {
  configuration: RunConfigurationSnapshot;
  items: OpenAINativeItem[];
  kind: "turn.input";
  turnId: string;
}

export interface ResponseEventRecord extends JournalRecordBase {
  event: JsonObject;
  kind: "response.event";
  responseId: string;
  sequenceNumber: number;
  turnId: string;
}

export interface TurnOutputRecord extends JournalRecordBase {
  items: OpenAINativeItem[];
  kind: "turn.output";
  response?: JsonObject;
  responseId: string;
  status: TerminalStatus;
  turnId: string;
}

export interface TurnAbortedRecord extends JournalRecordBase {
  error: JsonObject;
  kind: "turn.aborted";
  turnId: string;
}

export interface TurnFailedRecord extends JournalRecordBase {
  error: JsonObject;
  kind: "turn.failed";
  responseId?: string;
  turnId: string;
}

export type JournalRecord =
  | SessionCreatedRecord
  | TurnInputRecord
  | ResponseEventRecord
  | TurnOutputRecord
  | TurnAbortedRecord
  | TurnFailedRecord;

export interface SessionMetadata {
  activeTurnId?: string;
  createdAt: string;
  lastSequenceNumber: number;
  responseId?: string;
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  sessionId: string;
  status: RunStatus;
  updatedAt: string;
}

export interface AssistantMessageProjection {
  annotations: JsonObject[];
  id: string;
  outputIndex: number;
  phase: "commentary" | "final_answer" | "unknown";
  status: "in_progress" | "completed" | "incomplete";
  text: string;
}

export interface ReasoningProjection {
  id: string;
  outputIndex: number;
  summary: string;
}

export interface ToolProjection {
  action?: JsonObject;
  id: string;
  outputIndex: number;
  status: "in_progress" | "searching" | "completed" | "failed";
  toolType: string;
}

export interface ResponseProjection {
  assistantMessages: Record<string, AssistantMessageProjection>;
  lastSequenceNumber: number;
  reasoning: Record<string, ReasoningProjection>;
  responseId?: string;
  status: RunStatus;
  tools: Record<string, ToolProjection>;
  usage?: JsonObject;
}

interface NormalizedEventBase {
  responseId?: string;
  sequenceNumber: number;
  sourceType: string;
}

export interface LifecycleNormalizedEvent extends NormalizedEventBase {
  kind: "lifecycle";
  status: Exclude<RunStatus, "idle">;
}

export interface ReasoningNormalizedEvent extends NormalizedEventBase {
  delta?: string;
  itemId: string;
  kind: "reasoning";
  outputIndex: number;
}

export interface AssistantTextNormalizedEvent extends NormalizedEventBase {
  delta?: string;
  itemId: string;
  kind: "assistant_text";
  outputIndex: number;
  phase: "commentary" | "final_answer" | "unknown";
}

export interface ToolNormalizedEvent extends NormalizedEventBase {
  itemId: string;
  kind: "tool";
  outputIndex: number;
  status: ToolProjection["status"];
  toolType: string;
}

export interface AnnotationNormalizedEvent extends NormalizedEventBase {
  annotation: JsonObject;
  itemId: string;
  kind: "annotation";
  outputIndex: number;
}

export interface TerminalNormalizedEvent extends NormalizedEventBase {
  kind: "terminal";
  status: TerminalStatus;
  usage?: JsonObject;
}

export interface ErrorNormalizedEvent extends NormalizedEventBase {
  error: JsonObject;
  kind: "error";
}

export interface UnknownNormalizedEvent extends NormalizedEventBase {
  kind: "unknown";
  raw: JsonObject;
}

export type NormalizedEvent =
  | LifecycleNormalizedEvent
  | ReasoningNormalizedEvent
  | AssistantTextNormalizedEvent
  | ToolNormalizedEvent
  | AnnotationNormalizedEvent
  | TerminalNormalizedEvent
  | ErrorNormalizedEvent
  | UnknownNormalizedEvent;
