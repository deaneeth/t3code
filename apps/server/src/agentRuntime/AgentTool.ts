/**
 * AgentTool — canonical T3 tool interface.
 *
 * Every tool in the T3 agent runtime implements this interface. Tools are
 * provider-independent: the transport layer translates these into
 * provider-specific schemas (OpenAI function, Anthropic tool, etc.).
 *
 * @module agentRuntime/AgentTool
 */

/**
 * Risk classification for tools. Used by the policy engine to decide
 * whether to auto-approve, require user approval, or deny execution.
 */
export type ToolRisk = "read" | "write" | "execute" | "destructive" | "network";

/**
 * Capabilities a tool may advertise. Used for dynamic tool loading
 * and capability negotiation.
 */
export type ToolCapability =
  | "filesystem"
  | "search"
  | "shell"
  | "git"
  | "testing"
  | "user-interaction"
  | "planning"
  | "mcp";

/**
 * The result of executing a tool.
 */
export interface ToolResult {
  /** The output to send back to the LLM. */
  readonly output: string;
  /** Whether the tool execution succeeded. */
  readonly success: boolean;
  /** Optional metadata for the runtime (files changed, etc). */
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Context provided to tool execution.
 */
export interface AgentToolContext {
  /** The project working directory. */
  readonly cwd: string;
  /** The project root (may differ from cwd in monorepos). */
  readonly root: string;
  /** Resolve a relative path within the project, returning undefined if it escapes. */
  readonly resolvePath: (relative: string) => Promise<string | undefined>;
  /** Read a file as string. */
  readonly readFile: (absolutePath: string) => Promise<string>;
  /** Write a file as string. Creates parent directories. */
  readonly writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Delete a file when the host supports true deletion. */
  readonly deleteFile?: ((absolutePath: string) => Promise<void>) | undefined;
  /** List directory entries. */
  readonly listDirectory: (absolutePath: string) => Promise<readonly string[]>;
  /** Spawn a child process. Returns handles for stdout, stderr, exitCode, and kill. */
  readonly spawn: (
    command: string,
    args: readonly string[],
    options?: { cwd?: string },
  ) => Promise<{
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly exitCode: Promise<number | null>;
    readonly kill: () => void;
  }>;
}

/**
 * Canonical tool definition. The T3 agent runtime owns all tool
 * implementations; providers only receive translated schemas.
 */
export interface AgentTool {
  /** Unique tool identifier. */
  readonly id: string;
  /** Human-readable description for the LLM. */
  readonly description: string;
  /** JSON Schema for the tool's input parameters. */
  readonly inputSchema: Record<string, unknown>;
  /** Risk classification. */
  readonly risk: ToolRisk;
  /** Capability tags for dynamic loading. */
  readonly capabilities: ReadonlyArray<ToolCapability>;
  /** Whether this tool is enabled by default. */
  readonly enabled: boolean;
  /** Pre-execution argument validation. Returns error message or undefined. */
  readonly validate?: ((args: Record<string, unknown>) => string | undefined) | undefined;
  /** Execute the tool with the given arguments. */
  execute(args: Record<string, unknown>, context: AgentToolContext): Promise<ToolResult>;
}

/**
 * OpenAI-compatible function tool definition.
 */
export interface OpenAIToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/**
 * Convert a canonical AgentTool to an OpenAI function tool definition.
 */
export function toOpenAITool(tool: AgentTool): OpenAIToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.id,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * Convert a list of canonical AgentTools to OpenAI function tool definitions.
 */
export function toOpenAITools(tools: ReadonlyArray<AgentTool>): Array<OpenAIToolDefinition> {
  return tools.map(toOpenAITool);
}
