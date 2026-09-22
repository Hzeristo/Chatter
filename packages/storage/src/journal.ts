import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
} from "node:fs/promises";
import path from "node:path";

import {
  JOURNAL_SCHEMA_VERSION,
  type JournalRecord,
  type JsonObject,
  type OpenAINativeItem,
  type ResponseEventRecord,
  type RunConfigurationSnapshot,
  type RunStatus,
  type SessionMetadata,
  type TerminalStatus,
  type TurnLineage,
  type TurnAbortedRecord,
  type TurnFailedRecord,
  type TurnInputRecord,
  type TurnOutputRecord,
} from "@mas-chat/protocol";

import {
  InvalidSessionIdError,
  JournalCorruptionError,
  SessionStateError,
} from "./errors.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new InvalidSessionIdError(id);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventType(event: JsonObject): string | undefined {
  return typeof event.type === "string" ? event.type : undefined;
}

function statusFromEvent(event: JsonObject, fallback: RunStatus): RunStatus {
  switch (eventType(event)) {
    case "response.created":
    case "response.queued":
      return "queued";
    case "response.in_progress":
      return "in_progress";
    case "response.completed":
      return "completed";
    case "response.failed":
      return "failed";
    case "response.incomplete":
      return "incomplete";
    case "response.cancelled":
      return "cancelled";
    default:
      return fallback;
  }
}

function isTerminalStatus(status: RunStatus): status is TerminalStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "incomplete" ||
    status === "cancelled"
  );
}

function isNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

async function appendAndSync(filePath: string, record: JournalRecord): Promise<void> {
  const file = await open(filePath, "a");
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeJsonAtomically(
  filePath: string,
  value: SessionMetadata,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx");
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, filePath);
}

export function parseJournal(text: string): JournalRecord[] {
  const hasCompleteLastLine = text.length === 0 || text.endsWith("\n");
  const lines = text.split("\n");
  const records: JournalRecord[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") {
      continue;
    }

    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch (error) {
      const isTrailingPartialLine = index === lines.length - 1 && !hasCompleteLastLine;
      if (isTrailingPartialLine) {
        break;
      }
      throw new JournalCorruptionError(index + 1, error);
    }
  }

  return records;
}

function rebuildMetadata(
  sessionId: string,
  records: JournalRecord[],
  fallback?: SessionMetadata,
): SessionMetadata {
  const created = records.find((record) => record.kind === "session.created");
  const createdAt = fallback?.createdAt ?? created?.at;
  if (createdAt === undefined) {
    throw new SessionStateError(`Session ${sessionId} has no creation record`);
  }

  let metadata: SessionMetadata = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    sessionId,
    status: "idle",
    lastSequenceNumber: -1,
    createdAt,
    updatedAt: createdAt,
  };

  for (const record of records) {
    if (record.sessionId !== sessionId) {
      throw new SessionStateError(
        `Journal for ${sessionId} contains record for ${record.sessionId}`,
      );
    }

    switch (record.kind) {
      case "session.created":
        break;
      case "turn.input":
        const { responseId: _previousResponseId, ...withoutResponseId } = metadata;
        metadata = {
          ...withoutResponseId,
          activeTurnId: record.turnId,
          lastSequenceNumber: -1,
          status: "queued",
          updatedAt: record.at,
        };
        break;
      case "response.event":
        metadata = {
          ...metadata,
          activeTurnId: record.turnId,
          lastSequenceNumber: Math.max(
            metadata.lastSequenceNumber,
            record.sequenceNumber,
          ),
          responseId: record.responseId,
          status: statusFromEvent(record.event, metadata.status),
          updatedAt: record.at,
        };
        break;
      case "turn.output":
        const { activeTurnId: _finishedTurnId, ...withoutActiveTurn } = metadata;
        metadata = {
          ...withoutActiveTurn,
          responseId: record.responseId,
          status: record.status,
          updatedAt: record.at,
        };
        break;
      case "turn.aborted":
        const { activeTurnId: _abortedTurnId, responseId: _responseId, ...stable } =
          metadata;
        metadata = {
          ...stable,
          lastSequenceNumber: -1,
          status: "failed",
          updatedAt: record.at,
        };
        break;
      case "turn.failed":
        const { activeTurnId: _failedTurnId, ...withoutFailedTurn } = metadata;
        metadata = {
          ...withoutFailedTurn,
          ...(record.responseId === undefined
            ? {}
            : { responseId: record.responseId }),
          status: "failed",
          updatedAt: record.at,
        };
        break;
    }
  }

  return metadata;
}

export interface RecordResponseEventResult {
  duplicate: boolean;
  metadata: SessionMetadata;
}

export interface StoredSessionSnapshot {
  metadata: SessionMetadata;
  records: JournalRecord[];
}

export class SessionStore {
  readonly rootDirectory: string;
  readonly sessionsDirectory: string;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(rootDirectory: string) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.sessionsDirectory = path.join(this.rootDirectory, "sessions");
  }

  async createSession(sessionId: string, now = new Date()): Promise<SessionMetadata> {
    assertSafeId(sessionId);
    const at = now.toISOString();
    const directory = this.sessionDirectory(sessionId);
    await mkdir(this.sessionsDirectory, { recursive: true });
    await mkdir(directory);

    const metadata: SessionMetadata = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      sessionId,
      status: "idle",
      lastSequenceNumber: -1,
      createdAt: at,
      updatedAt: at,
    };
    const record: JournalRecord = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      kind: "session.created",
      sessionId,
      at,
    };

    await appendAndSync(this.journalPath(sessionId), record);
    await writeJsonAtomically(this.metadataPath(sessionId), metadata);
    return metadata;
  }

  async beginTurn(
    sessionId: string,
    turnId: string,
    items: OpenAINativeItem[],
    configuration: RunConfigurationSnapshot,
    lineage?: TurnLineage,
    now = new Date(),
  ): Promise<SessionMetadata> {
    assertSafeId(sessionId);
    assertSafeId(turnId);
    if (lineage !== undefined) {
      if (lineage.parentTurnId !== null) {
        assertSafeId(lineage.parentTurnId);
      }
      if (lineage.fork !== undefined) {
        assertSafeId(lineage.fork.sourceTurnId);
      }
      if (lineage.parentTurnId === turnId) {
        throw new SessionStateError("A turn cannot be its own parent");
      }
    }
    if (configuration.store !== false) {
      throw new SessionStateError("MAS Chat requires store:false for every turn");
    }
    if (items.length === 0) {
      throw new SessionStateError("A turn must contain at least one input item");
    }

    return this.withLock(sessionId, async () => {
      const current = await this.loadMetadataUnlocked(sessionId);
      if (current.activeTurnId !== undefined) {
        throw new SessionStateError(
          `Session ${sessionId} already has active turn ${current.activeTurnId}`,
        );
      }

      const at = now.toISOString();
      const record: TurnInputRecord = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        kind: "turn.input",
        sessionId,
        turnId,
        at,
        items,
        configuration,
        ...(lineage === undefined ? {} : { lineage }),
      };
      const { responseId: _previousResponseId, ...withoutResponseId } = current;
      const metadata: SessionMetadata = {
        ...withoutResponseId,
        activeTurnId: turnId,
        lastSequenceNumber: -1,
        status: "queued",
        updatedAt: at,
      };

      await appendAndSync(this.journalPath(sessionId), record);
      await writeJsonAtomically(this.metadataPath(sessionId), metadata);
      return metadata;
    });
  }

  async recordResponseEvent(
    sessionId: string,
    turnId: string,
    responseId: string,
    event: JsonObject,
    now = new Date(),
  ): Promise<RecordResponseEventResult> {
    assertSafeId(sessionId);
    assertSafeId(turnId);
    assertSafeId(responseId);

    const sequenceNumber = event.sequence_number;
    if (!Number.isSafeInteger(sequenceNumber) || (sequenceNumber as number) < 0) {
      throw new SessionStateError("Response event has no valid sequence_number");
    }

    return this.withLock(sessionId, async () => {
      const current = await this.loadMetadataUnlocked(sessionId);
      if (current.activeTurnId !== turnId) {
        throw new SessionStateError(
          `Turn ${turnId} is not active for session ${sessionId}`,
        );
      }
      if (current.responseId !== undefined && current.responseId !== responseId) {
        throw new SessionStateError(
          `Response ${responseId} does not match active response ${current.responseId}`,
        );
      }

      const sequence = sequenceNumber as number;
      if (sequence <= current.lastSequenceNumber) {
        return { duplicate: true, metadata: current };
      }

      const at = now.toISOString();
      const record: ResponseEventRecord = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        kind: "response.event",
        sessionId,
        turnId,
        responseId,
        sequenceNumber: sequence,
        event,
        at,
      };
      const metadata: SessionMetadata = {
        ...current,
        responseId,
        lastSequenceNumber: sequence,
        status: statusFromEvent(event, current.status),
        updatedAt: at,
      };

      await appendAndSync(this.journalPath(sessionId), record);
      await writeJsonAtomically(this.metadataPath(sessionId), metadata);
      return { duplicate: false, metadata };
    });
  }

  async recordTurnOutput(
    sessionId: string,
    turnId: string,
    responseId: string,
    status: TerminalStatus,
    items: OpenAINativeItem[],
    response?: JsonObject,
    now = new Date(),
  ): Promise<SessionMetadata> {
    assertSafeId(sessionId);
    assertSafeId(turnId);
    assertSafeId(responseId);

    return this.withLock(sessionId, async () => {
      const current = await this.loadMetadataUnlocked(sessionId);
      if (current.activeTurnId !== turnId) {
        throw new SessionStateError(
          `Turn ${turnId} is not active for session ${sessionId}`,
        );
      }
      if (current.responseId !== responseId) {
        throw new SessionStateError(
          `Response ${responseId} does not match active response ${String(current.responseId)}`,
        );
      }
      const confirmedCancellation =
        status === "cancelled" &&
        (current.status === "queued" || current.status === "in_progress");
      if (
        !confirmedCancellation &&
        (!isTerminalStatus(current.status) || current.status !== status)
      ) {
        throw new SessionStateError(
          `Cannot finalize ${turnId} as ${status} from state ${current.status}`,
        );
      }

      const at = now.toISOString();
      const record: TurnOutputRecord = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        kind: "turn.output",
        sessionId,
        turnId,
        responseId,
        status,
        items,
        at,
      };
      if (response !== undefined) {
        record.response = response;
      }
      const { activeTurnId: _finishedTurnId, ...withoutActiveTurn } = current;
      const metadata: SessionMetadata = {
        ...withoutActiveTurn,
        status,
        updatedAt: at,
      };

      await appendAndSync(this.journalPath(sessionId), record);
      await writeJsonAtomically(this.metadataPath(sessionId), metadata);
      return metadata;
    });
  }

  async abortTurn(
    sessionId: string,
    turnId: string,
    error: JsonObject,
    now = new Date(),
  ): Promise<SessionMetadata> {
    assertSafeId(sessionId);
    assertSafeId(turnId);

    return this.withLock(sessionId, async () => {
      const current = await this.loadMetadataUnlocked(sessionId);
      if (current.activeTurnId !== turnId) {
        throw new SessionStateError(
          `Turn ${turnId} is not active for session ${sessionId}`,
        );
      }
      if (current.responseId !== undefined) {
        throw new SessionStateError(
          `Cannot abort ${turnId} after response ${current.responseId} was created`,
        );
      }

      const at = now.toISOString();
      const record: TurnAbortedRecord = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        kind: "turn.aborted",
        sessionId,
        turnId,
        error,
        at,
      };
      const {
        activeTurnId: _abortedTurnId,
        responseId: _responseId,
        ...stable
      } = current;
      const metadata: SessionMetadata = {
        ...stable,
        lastSequenceNumber: -1,
        status: "failed",
        updatedAt: at,
      };

      await appendAndSync(this.journalPath(sessionId), record);
      await writeJsonAtomically(this.metadataPath(sessionId), metadata);
      return metadata;
    });
  }

  async failTurn(
    sessionId: string,
    turnId: string,
    error: JsonObject,
    now = new Date(),
  ): Promise<SessionMetadata> {
    assertSafeId(sessionId);
    assertSafeId(turnId);

    return this.withLock(sessionId, async () => {
      const current = await this.loadMetadataUnlocked(sessionId);
      if (current.activeTurnId !== turnId) {
        throw new SessionStateError(
          `Turn ${turnId} is not active for session ${sessionId}`,
        );
      }

      const at = now.toISOString();
      const record: TurnFailedRecord = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        kind: "turn.failed",
        sessionId,
        turnId,
        error,
        at,
      };
      if (current.responseId !== undefined) {
        record.responseId = current.responseId;
      }
      const { activeTurnId: _failedTurnId, ...withoutActiveTurn } = current;
      const metadata: SessionMetadata = {
        ...withoutActiveTurn,
        status: "failed",
        updatedAt: at,
      };

      await appendAndSync(this.journalPath(sessionId), record);
      await writeJsonAtomically(this.metadataPath(sessionId), metadata);
      return metadata;
    });
  }

  async loadMetadata(sessionId: string): Promise<SessionMetadata> {
    assertSafeId(sessionId);
    return this.withLock(sessionId, () => this.loadMetadataUnlocked(sessionId));
  }

  async readJournal(sessionId: string): Promise<JournalRecord[]> {
    assertSafeId(sessionId);
    return this.withLock(sessionId, () => this.readJournalUnlocked(sessionId));
  }

  async inspectSession(sessionId: string): Promise<StoredSessionSnapshot> {
    assertSafeId(sessionId);
    return this.withLock(sessionId, async () => {
      const records = await this.readJournalUnlocked(sessionId);
      return {
        metadata: rebuildMetadata(sessionId, records),
        records,
      };
    });
  }

  /**
   * Lists locally persisted sessions without exposing journal contents. The
   * caller can load a specific journal when it needs a conversation view.
   */
  async listSessions(): Promise<SessionMetadata[]> {
    return (await this.listSessionSnapshots()).map((snapshot) => snapshot.metadata);
  }

  async listSessionSnapshots(): Promise<StoredSessionSnapshot[]> {
    await mkdir(this.sessionsDirectory, { recursive: true });
    const entries = await readdir(this.sessionsDirectory, { withFileTypes: true });
    const sessions: StoredSessionSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) {
        continue;
      }
      sessions.push(await this.inspectSession(entry.name));
    }
    return sessions.sort((left, right) =>
      right.metadata.updatedAt.localeCompare(left.metadata.updatedAt),
    );
  }

  sessionDirectory(sessionId: string): string {
    assertSafeId(sessionId);
    return path.join(this.sessionsDirectory, sessionId);
  }

  journalPath(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "events.jsonl");
  }

  metadataPath(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "metadata.json");
  }

  async loadMetadataUnlocked(sessionId: string): Promise<SessionMetadata> {
    let persisted: SessionMetadata | undefined;
    try {
      persisted = JSON.parse(
        await readFile(this.metadataPath(sessionId), "utf8"),
      ) as SessionMetadata;
    } catch (error) {
      if (!isNotFound(error) && !(error instanceof SyntaxError)) {
        throw error;
      }
    }

    const records = await this.readJournalUnlocked(sessionId);
    const rebuilt = rebuildMetadata(sessionId, records, persisted);
    if (JSON.stringify(persisted) !== JSON.stringify(rebuilt)) {
      await writeJsonAtomically(this.metadataPath(sessionId), rebuilt);
    }
    return rebuilt;
  }

  async readJournalUnlocked(sessionId: string): Promise<JournalRecord[]> {
    const text = await readFile(this.journalPath(sessionId), "utf8");
    return parseJournal(text);
  }

  async withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#locks.set(sessionId, tail);
    await previous;

    try {
      return await operation();
    } finally {
      release?.();
      if (this.#locks.get(sessionId) === tail) {
        this.#locks.delete(sessionId);
      }
    }
  }
}
