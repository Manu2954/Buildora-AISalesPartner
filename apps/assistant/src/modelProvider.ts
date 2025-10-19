import { randomUUID } from 'node:crypto';
import { env } from '@buildora/shared';

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatMessage =
  | {
      role: 'system' | 'user';
      content: string;
    }
  | {
      role: 'assistant';
      content: string | null;
      toolCalls?: ToolCall[];
    }
  | {
      role: 'tool';
      name: string;
      toolCallId: string;
      content: string;
    };

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AssistantMessage = {
  role: 'assistant';
  content: string | null;
  toolCalls?: ToolCall[];
};

export type ModelResponse = {
  message: AssistantMessage;
  finishReason: string;
};

export interface LanguageModel {
  generate(input: { messages: ChatMessage[]; tools: ToolDefinition[] }): Promise<ModelResponse>;
}

export function createModel(): LanguageModel {
  const apiKey = env.OPENAI_API_KEY;
  const modelName = env.OPENAI_MODEL;
  const endpoint = 'https://api.openai.com/v1/chat/completions';

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required to run the assistant');
  }

  return {
    async generate(input) {
      const body = {
        model: modelName,
        temperature: 0.4,
        messages: input.messages.map(mapMessageToOpenAI),
        tools: input.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        tool_choice: 'auto'
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const payload = await response.json().catch(() => {
        throw new Error('Failed to parse response from OpenAI');
      });

      if (!response.ok) {
        const message = payload?.error?.message ?? response.statusText;
        throw new Error(`OpenAI request failed: ${message}`);
      }

      const choice = payload?.choices?.[0];
      if (!choice || !choice.message) {
        throw new Error('OpenAI response missing choices');
      }

      const assistantMessage = mapAssistantMessage(choice.message);
      return {
        message: assistantMessage,
        finishReason: choice.finish_reason ?? 'unknown'
      };
    }
  };
}

function mapMessageToOpenAI(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      name: message.name,
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }

  if (message.role === 'assistant') {
    const content = message.content ?? '';
    const payload: Record<string, unknown> = {
      role: 'assistant',
      content
    };
    if (message.toolCalls && message.toolCalls.length > 0) {
      payload.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {})
        }
      }));
    }
    return payload;
  }

  return {
    role: message.role,
    content: message.content
  };
}

function mapAssistantMessage(message: any): AssistantMessage {
  const content = typeof message.content === 'string' ? message.content : message.content?.[0]?.text?.value ?? null;

  if (!message.tool_calls || message.tool_calls.length === 0) {
    return {
      role: 'assistant',
      content
    };
  }

  const toolCalls: ToolCall[] = message.tool_calls.map((call: any) => {
    let parsedArguments: Record<string, unknown>;
    try {
      parsedArguments =
        typeof call.function?.arguments === 'string'
          ? JSON.parse(call.function.arguments)
          : call.function?.arguments ?? {};
    } catch (error) {
      console.error('[assistant] Failed to parse tool call arguments', error);
      parsedArguments = {};
    }

    return {
      id: call.id ?? randomUUID(),
      name: call.function?.name ?? 'unknown_tool',
      arguments: parsedArguments
    };
  });

  return {
    role: 'assistant',
    content,
    toolCalls
  };
}
