/**
 * User interaction and agent workflow tools.
 *
 * Provides: ask_user, finish_task
 *
 * @module agentRuntime/tools/agent
 */
import type { AgentTool, ToolResult } from "../AgentTool.ts";

export const askUserTool: AgentTool = {
  id: "ask_user",
  description:
    "Ask the user a structured multiple-choice question. Use when you need clarification or a decision before proceeding.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique question identifier." },
            header: { type: "string", description: "Short label for the question." },
            question: { type: "string", description: "The full question text." },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label", "description"],
              },
            },
            multiSelect: { type: "boolean", description: "Allow multiple selections." },
          },
          required: ["id", "header", "question", "options"],
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  risk: "read",
  capabilities: ["user-interaction"],
  enabled: true,

  async execute(_args, _context): Promise<ToolResult> {
    // ask_user is handled specially by the adapter runtime via deferred/prompts.
    // This implementation is a fallback for testing.
    return { output: "User input requested (handled by adapter).", success: true };
  },
};

export const finishTaskTool: AgentTool = {
  id: "finish_task",
  description:
    "Signal task completion with a summary. Call this when you believe the task is done. The runtime will verify before marking complete.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Concise summary of what was done.",
      },
      changedFiles: {
        type: "array",
        items: { type: "string" },
        description: "List of files that were modified.",
      },
      verification: {
        type: "string",
        description: "Description of verification performed (tests run, diffs inspected, etc).",
      },
    },
    required: ["summary"],
    additionalProperties: false,
  },
  risk: "read",
  capabilities: ["planning"],
  enabled: true,

  async execute(args, _context): Promise<ToolResult> {
    const summary = typeof args.summary === "string" ? args.summary : "Task completed.";
    const files = Array.isArray(args.changedFiles)
      ? args.changedFiles.filter((f): f is string => typeof f === "string")
      : [];
    const verification = typeof args.verification === "string" ? args.verification : "";
    const parts = [summary];
    if (files.length > 0) parts.push(`Changed: ${files.join(", ")}`);
    if (verification) parts.push(`Verified: ${verification}`);
    return { output: parts.join("\n"), success: true, metadata: { finished: true } };
  },
};

export const agentTools: ReadonlyArray<AgentTool> = [askUserTool, finishTaskTool];
