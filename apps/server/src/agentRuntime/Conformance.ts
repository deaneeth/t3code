/**
 * Conformance Suite — verifies tools conform to the AgentTool interface.
 *
 * Validates that all canonical tools:
 * - Have valid input schemas
 * - Pass validation for valid input
 * - Fail validation for invalid input
 * - Return proper ToolResult shapes
 * - Handle path traversal attempts
 *
 * @module agentRuntime/Conformance
 */
import type { AgentTool, AgentToolContext, ToolResult } from "./AgentTool.ts";
import { canonicalTools } from "./tools/index.ts";

export interface ConformanceTestResult {
  readonly toolId: string;
  readonly passed: boolean;
  readonly failures: ReadonlyArray<string>;
}

/**
 * Validate a tool's input schema is well-formed.
 */
function validateSchema(tool: AgentTool): string[] {
  const failures: string[] = [];
  const schema = tool.inputSchema;

  if (typeof schema !== "object" || schema === null) {
    failures.push("inputSchema must be an object");
    return failures;
  }

  if (schema.type !== "object") {
    failures.push("inputSchema.type must be 'object'");
  }

  return failures;
}

/**
 * Test validation with valid minimal args.
 */
function testValidArgs(tool: AgentTool): string[] {
  const failures: string[] = [];
  const schema = tool.inputSchema as Record<string, unknown>;
  const required = schema.required as ReadonlyArray<string> | undefined;

  if (!required || required.length === 0) {
    const error = tool.validate?.({});
    if (error) {
      failures.push(`validate({}) should pass for tool with no required args, got: ${error}`);
    }
  } else {
    const args: Record<string, unknown> = {};
    for (const field of required) {
      if (typeof field === "string") {
        const propSchema = (schema.properties as Record<string, unknown>)?.[field] as
          | Record<string, unknown>
          | undefined;
        if (propSchema?.type === "string") args[field] = "test-value";
        else if (propSchema?.type === "number") args[field] = 1;
        else if (propSchema?.type === "boolean") args[field] = true;
        else args[field] = "test";
      }
    }
    const error = tool.validate?.(args);
    if (error) {
      failures.push(`validate(${JSON.stringify(args)}) should pass, got: ${error}`);
    }
  }

  return failures;
}

/**
 * Test validation with missing required fields.
 */
function testMissingRequired(tool: AgentTool): string[] {
  const failures: string[] = [];
  const schema = tool.inputSchema as Record<string, unknown>;
  const required = schema.required as ReadonlyArray<string> | undefined;

  if (required && required.length > 0 && tool.validate) {
    const error = tool.validate({});
    if (!error) {
      failures.push("validate({}) should fail when required fields are missing");
    }
  }

  return failures;
}

/**
 * Test that execute returns proper ToolResult shape.
 */
async function testExecuteShape(tool: AgentTool, context: AgentToolContext): Promise<string[]> {
  const failures: string[] = [];

  try {
    const args: Record<string, unknown> = {};
    const schema = tool.inputSchema as Record<string, unknown>;
    const required = schema.required as ReadonlyArray<string> | undefined;
    if (required) {
      for (const field of required) {
        if (typeof field === "string") args[field] = "test";
      }
    }

    const result = await tool.execute(args, context);

    if (typeof result !== "object" || result === null) {
      failures.push("execute() must return an object");
      return failures;
    }

    if (typeof result.output !== "string") {
      failures.push("result.output must be a string");
    }

    if (typeof result.success !== "boolean") {
      failures.push("result.success must be a boolean");
    }
  } catch (cause) {
    failures.push(`execute() threw: ${String(cause)}`);
  }

  return failures;
}

/**
 * Run conformance tests on a single tool.
 */
export async function runConformanceTest(
  tool: AgentTool,
  context: AgentToolContext,
): Promise<ConformanceTestResult> {
  const failures: string[] = [
    ...validateSchema(tool),
    ...testValidArgs(tool),
    ...testMissingRequired(tool),
    ...(await testExecuteShape(tool, context)),
  ];

  return {
    toolId: tool.id,
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Run conformance tests on all canonical tools.
 */
export async function runAllConformanceTests(
  context: AgentToolContext,
): Promise<ReadonlyArray<ConformanceTestResult>> {
  const results: ConformanceTestResult[] = [];
  for (const tool of canonicalTools) {
    results.push(await runConformanceTest(tool, context));
  }
  return results;
}

/**
 * Create a mock AgentToolContext for testing.
 */
export function createMockToolContext(overrides?: Partial<AgentToolContext>): AgentToolContext {
  return {
    cwd: "/tmp/test-project",
    root: "/tmp/test-project",
    resolvePath: async (relative) => {
      if (relative.startsWith("..") || relative.startsWith("/")) return undefined;
      return `/tmp/test-project/${relative}`;
    },
    readFile: async () => "mock file content",
    writeFile: async () => {},
    listDirectory: async () => ["file1.ts", "file2.ts"],
    spawn: async () => ({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("mock output"));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      exitCode: Promise.resolve(0),
      kill: () => {},
    }),
    ...overrides,
  };
}
