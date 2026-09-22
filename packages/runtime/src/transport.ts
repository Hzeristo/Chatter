import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import type { JsonObject } from "@mas-chat/protocol";

export interface ResponsesTransport {
  cancel(responseId: string): Promise<JsonObject>;
  create(
    request: ResponseCreateParamsStreaming,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<JsonObject>>;
  resume(
    responseId: string,
    startingAfter: number,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<JsonObject>>;
}

function asJsonObject(event: ResponseStreamEvent): JsonObject {
  return event as unknown as JsonObject;
}

async function* mapStream(
  stream: AsyncIterable<ResponseStreamEvent>,
): AsyncGenerator<JsonObject> {
  for await (const event of stream) {
    yield asJsonObject(event);
  }
}

/** Thin official-SDK transport. Constructing it performs no API request. */
export class OpenAIResponsesTransport implements ResponsesTransport {
  readonly #client: OpenAI;

  constructor(client: OpenAI) {
    this.#client = client;
  }

  async cancel(responseId: string): Promise<JsonObject> {
    const response = await this.#client.responses.cancel(responseId);
    return response as unknown as JsonObject;
  }

  async create(
    request: ResponseCreateParamsStreaming,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<JsonObject>> {
    const stream = await this.#client.responses.create(request, { signal });
    return mapStream(stream);
  }

  async resume(
    responseId: string,
    startingAfter: number,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<JsonObject>> {
    const stream = await this.#client.responses.retrieve(
      responseId,
      {
        stream: true,
        starting_after: startingAfter,
      },
      { signal },
    );
    return mapStream(stream);
  }
}
