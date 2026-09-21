import type {
  ResponseCreateParamsStreaming,
  ResponseIncludable,
  ResponseInputItem,
  Tool,
} from "openai/resources/responses/responses";

import type {
  JsonObject,
  RunConfigurationSnapshot,
} from "@mas-chat/protocol";

export interface StatelessRequestOptions {
  /** `null` deliberately omits both request-level prompt layers. */
  developerPrompt?: string | null;
  /** A short request-level cue used on every turn to carry the session forward. */
  sessionFollowingInstruction?: string | null;
  enableCodeInterpreter?: boolean;
  enableWebSearch?: boolean;
  model?: string;
  reasoningEffort?: RuntimeReasoningEffort;
  reasoningSummary?: RuntimeReasoningSummary;
  textVerbosity?: RuntimeTextVerbosity;
  tools?: Tool[];
}

export type RuntimeReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type RuntimeReasoningSummary = "auto" | "concise" | "detailed";
export type RuntimeTextVerbosity = "low" | "medium" | "high";

export const DEFAULT_DEVELOPER_PROMPT =
  "Help the user complete the requested task. Keep progress updates concise and provide a clear final answer.";

export const DEFAULT_SESSION_FOLLOWING_INSTRUCTION_V1 =
  "Continue the established conversation naturally: carry forward its tone, concepts, and unfinished threads; treat each turn as a continuation, adding substantive thought when warranted without forcing length or closure.";

export const DEFAULT_SESSION_FOLLOWING_INSTRUCTION =
  DEFAULT_SESSION_FOLLOWING_INSTRUCTION_V1;

/**
 * The base prompt participates only in the first request. The continuation cue
 * is request-scoped and therefore appears exactly once on every request rather
 * than accumulating in replay history.
 */
export function buildSessionInstructions(
  history: ResponseInputItem[],
  options: StatelessRequestOptions = {},
): string | undefined {
  if (options.developerPrompt === null) {
    return undefined;
  }

  const following =
    options.sessionFollowingInstruction === null
      ? undefined
      : (options.sessionFollowingInstruction ??
        DEFAULT_SESSION_FOLLOWING_INSTRUCTION_V1);
  if (history.length > 0) {
    return following;
  }

  return [options.developerPrompt ?? DEFAULT_DEVELOPER_PROMPT, following]
    .map((section) => section?.trim())
    .filter(
      (section): section is string =>
        section !== undefined && section !== "",
    )
    .join("\n\n");
}

function defaultTools(
  enableWebSearch: boolean,
  enableCodeInterpreter: boolean,
): Tool[] {
  const tools: Tool[] = [];
  if (enableWebSearch) {
    tools.push({ type: "web_search" });
  }
  if (enableCodeInterpreter) {
    tools.push({ type: "code_interpreter", container: { type: "auto" } });
  }
  return tools;
}

export function buildStatelessResponseRequest(
  history: ResponseInputItem[],
  newItems: ResponseInputItem[],
  options: StatelessRequestOptions = {},
  background = true,
): ResponseCreateParamsStreaming {
  if (newItems.length === 0) {
    throw new Error("A response request requires at least one new input item");
  }

  const instructions = buildSessionInstructions(history, options);

  const tools =
    options.tools ??
    defaultTools(
      options.enableWebSearch ?? true,
      options.enableCodeInterpreter ?? false,
    );
  const include: ResponseIncludable[] = ["reasoning.encrypted_content"];
  if (
    tools.some(
      (tool) =>
        tool.type === "web_search" || tool.type === "web_search_preview",
    )
  ) {
    include.push("web_search_call.action.sources");
  }
  if (tools.some((tool) => tool.type === "code_interpreter")) {
    include.push("code_interpreter_call.outputs");
  }
  return {
    model: options.model ?? "gpt-6-astra",
    ...(background ? { background: true as const } : {}),
    stream: true,
    store: false,
    input: [...history, ...newItems],
    ...(instructions === undefined || instructions === ""
      ? {}
      : { instructions }),
    reasoning: {
      effort: options.reasoningEffort ?? "max",
      summary: options.reasoningSummary ?? "auto",
      context: "all_turns",
    },
    text: {
      verbosity: options.textVerbosity ?? "medium",
    },
    tools,
    include,
  };
}

export function snapshotRunConfiguration(
  request: ResponseCreateParamsStreaming,
): RunConfigurationSnapshot {
  if (request.store !== false) {
    throw new Error("Only store:false requests may be journaled by MAS Chat");
  }
  if (request.stream !== true) {
    throw new Error("MAS Chat requires stream:true");
  }

  return {
    model: String(request.model),
    background: request.background === true,
    stream: true,
    store: false,
    ...(typeof request.instructions === "string"
      ? { instructions: request.instructions }
      : {}),
    reasoning: structuredClone((request.reasoning ?? {}) as JsonObject),
    text: structuredClone((request.text ?? {}) as JsonObject),
    tools: structuredClone((request.tools ?? []) as unknown as JsonObject[]),
    include: structuredClone(request.include ?? []),
  };
}
