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
  developerPrompt?: string;
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
    instructions: options.developerPrompt ?? DEFAULT_DEVELOPER_PROMPT,
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
    instructions: request.instructions ?? "",
    reasoning: structuredClone((request.reasoning ?? {}) as JsonObject),
    text: structuredClone((request.text ?? {}) as JsonObject),
    tools: structuredClone((request.tools ?? []) as unknown as JsonObject[]),
    include: structuredClone(request.include ?? []),
  };
}
