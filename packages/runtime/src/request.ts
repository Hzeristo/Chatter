import type {
  ResponseCreateParamsStreaming,
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
  model?: string;
  tools?: Tool[];
}

export const DEFAULT_DEVELOPER_PROMPT =
  "Help the user complete the requested task. Keep progress updates concise and provide a clear final answer.";

function defaultTools(enableCodeInterpreter: boolean): Tool[] {
  const tools: Tool[] = [{ type: "web_search" }];
  if (enableCodeInterpreter) {
    tools.push({ type: "code_interpreter", container: { type: "auto" } });
  }
  return tools;
}

export function buildStatelessResponseRequest(
  history: ResponseInputItem[],
  newItems: ResponseInputItem[],
  options: StatelessRequestOptions = {},
): ResponseCreateParamsStreaming {
  if (newItems.length === 0) {
    throw new Error("A response request requires at least one new input item");
  }

  return {
    model: options.model ?? "gpt-6-astra",
    background: true,
    stream: true,
    store: false,
    input: [...history, ...newItems],
    instructions: options.developerPrompt ?? DEFAULT_DEVELOPER_PROMPT,
    reasoning: {
      effort: "max",
      summary: "auto",
      context: "all_turns",
    },
    text: {
      verbosity: "medium",
    },
    tools: options.tools ?? defaultTools(options.enableCodeInterpreter ?? false),
    include: [
      "reasoning.encrypted_content",
      "web_search_call.action.sources",
    ],
  };
}

export function snapshotRunConfiguration(
  request: ResponseCreateParamsStreaming,
): RunConfigurationSnapshot {
  if (request.store !== false) {
    throw new Error("Only store:false requests may be journaled by MAS Chat");
  }
  if (request.background !== true || request.stream !== true) {
    throw new Error("MAS Chat requires background:true and stream:true");
  }

  return {
    model: String(request.model),
    background: true,
    stream: true,
    store: false,
    instructions: request.instructions ?? "",
    reasoning: structuredClone((request.reasoning ?? {}) as JsonObject),
    text: structuredClone((request.text ?? {}) as JsonObject),
    tools: structuredClone((request.tools ?? []) as unknown as JsonObject[]),
    include: structuredClone(request.include ?? []),
  };
}
