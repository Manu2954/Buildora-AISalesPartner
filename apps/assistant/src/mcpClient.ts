import { httpRequest, AppError } from '@buildora/shared';

type ToolSchema = {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
};

type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolExecutionResult<TResult> = {
  name: string;
  result: TResult;
};

export class McpClient {
  private toolListPromise: Promise<string[]> | null = null;
  private schemaCache = new Map<string, Promise<ToolSchema>>();

  constructor(private readonly baseUrl: string, private readonly actor: string) {}

  async listTools(): Promise<string[]> {
    if (!this.toolListPromise) {
      this.toolListPromise = this.fetchJson<{ tools: string[] }>('/schemas').then((payload) => {
        if (!payload.tools || !Array.isArray(payload.tools)) {
          throw new AppError('MCP_TOOL_LIST_INVALID', 'Invalid response when listing tools');
        }
        return payload.tools;
      });
    }
    return this.toolListPromise;
  }

  async getToolSchema(toolName: string): Promise<ToolSchema> {
    if (!this.schemaCache.has(toolName)) {
      const promise = this.fetchJson<ToolSchema>(`/schemas/${encodeURIComponent(toolName)}`);
      this.schemaCache.set(toolName, promise);
    }
    return this.schemaCache.get(toolName)!;
  }

  async getToolSpecs(
    toolNames: string[],
    descriptions: Map<string, string>
  ): Promise<ToolSpec[]> {
    const results: ToolSpec[] = [];
    for (const toolName of toolNames) {
      try {
        const schema = await this.getToolSchema(toolName);
        if (!schema?.input || typeof schema.input !== 'object') {
          continue;
        }
        const description =
          descriptions.get(toolName) ??
          `MCP tool ${toolName} (input schema: ${Object.keys(schema.input).join(', ')})`;
        results.push({
          name: toolName,
          description,
          parameters: schema.input
        });
      } catch (error) {
        console.error(`[assistant] Failed to load schema for tool ${toolName}`, error);
      }
    }
    return results;
  }

  async callTool<TInput extends Record<string, unknown>, TResult = unknown>(
    toolName: string,
    input: TInput
  ): Promise<TResult> {
    const payload = await httpRequest<{ result: TResult; error?: { message: string } }>(
      this.buildUrl(`/tools/${encodeURIComponent(toolName)}`),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor': this.actor
        },
        body: JSON.stringify({ actor: this.actor, input })
      }
    );

    if (payload?.error) {
      const message = payload.error.message ?? 'Unknown error';
      throw new AppError('MCP_TOOL_ERROR', message);
    }
    if (!('result' in payload)) {
      throw new AppError('MCP_MALFORMED_RESPONSE', `MCP tool ${toolName} returned malformed payload`);
    }
    return payload.result as TResult;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    return httpRequest<T>(this.buildUrl(path), {
      headers: {
        Accept: 'application/json'
      }
    });
  }

  private buildUrl(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }
}
