// @effect-diagnostics globalFetch:off

/**
 * MCPManager — converts MCP tools to canonical AgentTools.
 *
 * Wraps external MCP server tools so they can participate in the
 * universal agent runtime. Each MCP tool is wrapped as a canonical
 * AgentTool with appropriate risk classification and validation.
 *
 * @module agentRuntime/MCPManager
 */
import type { AgentTool, AgentToolContext, ToolResult } from "./AgentTool.ts";

/**
 * An MCP tool as discovered from an MCP server.
 */
export interface MCPToolDefinition {
  /** Tool name as reported by the MCP server. */
  readonly name: string;
  /** Human-readable description. */
  readonly description: string;
  /** JSON Schema for input parameters. */
  readonly inputSchema: Record<string, unknown>;
  /** The MCP server endpoint this tool belongs to. */
  readonly serverEndpoint: string;
  /** Authentication header for invoking this tool. */
  readonly authHeader: string;
}

function normalizeEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

/**
 * Wraps an MCP tool as a canonical AgentTool.
 *
 * MCP tools are always classified as "network" risk since they invoke
 * external services. The wrapping validates input against the schema
 * and proxies the invocation to the MCP server.
 */
export function wrapMCPTool(definition: MCPToolDefinition): AgentTool {
  const { name, description, inputSchema, serverEndpoint, authHeader } = definition;
  const normalizedEndpoint = normalizeEndpoint(serverEndpoint);

  return {
    id: `mcp_${name}`,
    description: `[MCP] ${description}`,
    inputSchema,
    risk: "network" as const,
    capabilities: ["mcp"],
    enabled: true,

    validate(args): string | undefined {
      const required = inputSchema.required;
      if (Array.isArray(required)) {
        for (const field of required) {
          if (typeof field === "string" && (args[field] === undefined || args[field] === null)) {
            return `Missing required field: ${field}`;
          }
        }
      }
      return undefined;
    },

    async execute(args, _context): Promise<ToolResult> {
      if (!normalizedEndpoint) {
        return { output: `MCP tool '${name}' has an invalid server endpoint.`, success: false };
      }
      try {
        const response = await fetch(`${normalizedEndpoint}/call`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
          body: JSON.stringify({
            tool: name,
            arguments: args,
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          return {
            output: `MCP tool '${name}' failed (HTTP ${response.status}): ${body}`,
            success: false,
          };
        }

        const result = (await response.json()) as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };

        if (result.content && Array.isArray(result.content)) {
          const textParts = result.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text);
          const output = textParts.join("\n");
          return {
            output: output || `MCP tool '${name}' completed (no text output).`,
            success: !result.isError,
          };
        }

        return {
          output: `MCP tool '${name}' completed.`,
          success: true,
        };
      } catch (cause) {
        return {
          output: `MCP tool '${name}' failed: ${String(cause)}`,
          success: false,
        };
      }
    },
  };
}

/**
 * Convert a list of MCP tool definitions to canonical AgentTools.
 */
export function wrapMCPTools(tools: ReadonlyArray<MCPToolDefinition>): Array<AgentTool> {
  return tools.filter((tool) => tool.name.trim().length > 0).map(wrapMCPTool);
}

/**
 * Discover available tools from an MCP server.
 * Makes a tools/list call to the MCP server.
 */
export async function discoverMCPTools(
  serverEndpoint: string,
  authHeader: string,
): Promise<Array<MCPToolDefinition>> {
  const normalizedEndpoint = normalizeEndpoint(serverEndpoint);
  if (!normalizedEndpoint) return [];
  try {
    const response = await fetch(`${normalizedEndpoint}/tools`, {
      method: "GET",
      headers: authHeader ? { Authorization: authHeader } : {},
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
    };

    if (!payload.tools || !Array.isArray(payload.tools)) {
      return [];
    }

    return payload.tools
      .filter((tool) => typeof tool.name === "string" && tool.name.trim().length > 0)
      .map((tool) => ({
        name: tool.name.trim(),
        description: tool.description ?? `MCP tool: ${tool.name.trim()}`,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        serverEndpoint: normalizedEndpoint,
        authHeader,
      }));
  } catch {
    return [];
  }
}
