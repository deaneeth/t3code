// @effect-diagnostics globalFetch:off nodeBuiltinImport:off

import { afterEach, describe, expect, it } from "vite-plus/test";
import { resolve as resolvePath } from "node:path";

import { runAgentLoop } from "../AgentLoop.ts";
import type { AgentToolContext, AgentTool } from "../AgentTool.ts";
import { applyPatchTool, readFileTool } from "../tools/filesystem.ts";
import { runCommandTool } from "../tools/shell.ts";
import type { LLMTransport } from "../transport/LLMTransport.ts";
import { AnthropicTransport } from "../transport/AnthropicTransport.ts";
import { GeminiTransport } from "../transport/GeminiTransport.ts";
import { OpenAIChatTransport } from "../transport/OpenAIChatTransport.ts";
import { OpenAIResponsesTransport } from "../transport/OpenAIResponsesTransport.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function streamOf(value: string, close = true): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      if (close) controller.close();
    },
  });
}

function memoryContext(initial: Record<string, string> = {}): AgentToolContext & {
  readonly files: Map<string, string>;
} {
  const root = "/project";
  const files = new Map(Object.entries(initial));
  return {
    cwd: root,
    root,
    files,
    resolvePath: async (value) => {
      const normalized = value.startsWith("/") ? resolvePath(value) : resolvePath(root, value);
      return normalized === root || normalized.startsWith(`${root}/`) ? normalized : undefined;
    },
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    deleteFile: async (path) => {
      files.delete(path);
    },
    listDirectory: async () => [],
    spawn: async () => ({
      stdout: streamOf(""),
      stderr: streamOf(""),
      exitCode: Promise.resolve(0),
      kill: () => {},
    }),
  };
}

describe("agent runtime filesystem boundaries", () => {
  it("applies a standard unified diff and rejects a context mismatch", async () => {
    const context = memoryContext({ "/project/demo.txt": "one\ntwo\nthree" });
    const result = await applyPatchTool.execute(
      {
        patch: [
          "--- a/demo.txt",
          "+++ b/demo.txt",
          "@@ -1,3 +1,3 @@",
          " one",
          "-two",
          "+TWO",
          " three",
        ].join("\n"),
      },
      context,
    );
    expect(result.success).toBe(true);
    expect(context.files.get("/project/demo.txt")).toBe("one\nTWO\nthree");

    const mismatch = await applyPatchTool.execute(
      { patch: "--- a/demo.txt\n+++ b/demo.txt\n@@ -1,1 +1,1 @@\n-wrong\n+value" },
      context,
    );
    expect(mismatch.success).toBe(false);
    expect(context.files.get("/project/demo.txt")).toBe("one\nTWO\nthree");
  });

  it("supports add/delete directives and prevents paths outside the root", async () => {
    const context = memoryContext({ "/project/old.txt": "old" });
    const added = await applyPatchTool.execute(
      { patch: "*** Begin Patch\n*** Add File: new.txt\n+created\n*** End Patch" },
      context,
    );
    expect(added.success).toBe(true);
    expect(context.files.get("/project/new.txt")).toBe("created");

    const deleted = await applyPatchTool.execute(
      { patch: "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch" },
      context,
    );
    expect(deleted.success).toBe(true);
    expect(context.files.has("/project/old.txt")).toBe(false);

    const outside = await readFileTool.execute(
      { absoluteFilePath: "/project/../secret.txt" },
      context,
    );
    expect(outside.success).toBe(false);
    expect(outside.output).toContain("outside");
  });

  it("does not partially apply a multi-file patch when a later file is invalid", async () => {
    const context = memoryContext({
      "/project/first.txt": "before",
      "/project/second.txt": "stable",
    });
    const result = await applyPatchTool.execute(
      {
        patch: [
          "--- a/first.txt",
          "+++ b/first.txt",
          "@@ -1,1 +1,1 @@",
          "-before",
          "+changed",
          "--- a/second.txt",
          "+++ b/second.txt",
          "@@ -1,1 +1,1 @@",
          "-wrong",
          "+also changed",
        ].join("\n"),
      },
      context,
    );
    expect(result.success).toBe(false);
    expect(context.files.get("/project/first.txt")).toBe("before");
    expect(context.files.get("/project/second.txt")).toBe("stable");
  });
});

describe("agent runtime shell boundaries", () => {
  it("kills a process when output exceeds the limit instead of waiting forever", async () => {
    let killed = false;
    let resolveExit!: (code: number) => void;
    const context = {
      ...memoryContext(),
      spawn: async () => ({
        stdout: streamOf("x".repeat(600_000), false),
        stderr: streamOf(""),
        exitCode: new Promise<number>((resolve) => {
          resolveExit = resolve;
        }),
        kill: () => {
          killed = true;
          resolveExit(137);
        },
      }),
    } satisfies AgentToolContext;

    const result = await runCommandTool.execute({ command: "produce-output" }, context);
    expect(killed).toBe(true);
    expect(result.success).toBe(false);
    expect(result.output).toContain("exceeded size limit");
  });
});

function fakeTransport(responseCount: { value: number }): LLMTransport {
  return {
    providerKind: "openai",
    buildRequest: ({ baseUrl }) => ({ url: `${baseUrl}/chat`, headers: {}, body: {} }),
    parseResponse: (payload) => ({
      text: typeof payload.text === "string" ? payload.text : "",
      toolCalls: [],
    }),
    parseSseEvents: (block) => {
      if (block.includes('"start"')) {
        return [
          { kind: "tool-call", toolCallId: "call-1", toolCallIndex: 0, toolName: "read_file" },
        ];
      }
      if (block.includes('"delta"')) {
        return [
          {
            kind: "tool-call-delta",
            toolCallIndex: 0,
            toolArgumentsDelta: '{"absoluteFilePath":"/project/demo.txt"}',
          },
        ];
      }
      return block.includes("[DONE]") ? [{ kind: "done" }] : [];
    },
    normalizeError: (body, status) => ({ message: `${status}:${body}`, retryable: false }),
    normalizeUsage: () => undefined,
  };
}

describe("agent loop transport boundaries", () => {
  it("keeps CRLF SSE tool fragments under one tool-call id", async () => {
    const responseCount = { value: 0 };
    globalThis.fetch = (async () => {
      responseCount.value += 1;
      if (responseCount.value === 1) {
        return new Response(
          'data: {"start":true}\r\n\r\ndata: {"delta":true}\r\n\r\ndata: [DONE]\r\n\r\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ text: "finished" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const context = memoryContext({ "/project/demo.txt": "contents" });
    const tool: AgentTool = {
      ...readFileTool,
      execute: (args, toolContext) => readFileTool.execute(args, toolContext),
    };
    const result = await runAgentLoop({
      transport: fakeTransport(responseCount),
      tools: [tool],
      toolContext: context,
      text: "read it",
      model: "test",
      baseUrl: "https://example.test",
      headers: {},
    });
    expect(result.stopReason).toBe("completed");
    expect(result.text).toBe("finished");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.id).toBe("call-1");
  });

  it("reports max-rounds and malformed JSON instead of claiming completion", async () => {
    const responseCount = { value: 0 };
    globalThis.fetch = (async () =>
      new Response("not-json", {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const transport = fakeTransport(responseCount);
    const context = memoryContext();
    const maxed = await runAgentLoop({
      transport: {
        ...transport,
        parseResponse: () => ({
          text: "",
          toolCalls: [{ id: "x", name: "read_file", arguments: "{}" }],
        }),
      },
      tools: [readFileTool],
      toolContext: context,
      text: "loop",
      model: "test",
      baseUrl: "https://example.test",
      headers: {},
      config: { maxRounds: 0 },
    });
    expect(maxed.stopReason).toBe("max-rounds");

    const malformed = await runAgentLoop({
      transport,
      tools: [],
      toolContext: context,
      text: "bad",
      model: "test",
      baseUrl: "https://example.test",
      headers: {},
    });
    expect(malformed.stopReason).toBe("error");
    expect(malformed.text).toContain("Invalid provider response");
  });

  it("surfaces provider SSE errors instead of silently completing", async () => {
    globalThis.fetch = (async () =>
      new Response('data: {"error":"quota exceeded"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof globalThis.fetch;
    const result = await runAgentLoop({
      transport: {
        ...fakeTransport({ value: 0 }),
        parseSseEvents: () => [{ kind: "error", error: "quota exceeded" }],
      },
      tools: [],
      toolContext: memoryContext(),
      text: "fail",
      model: "test",
      baseUrl: "https://example.test",
      headers: {},
    });
    expect(result.stopReason).toBe("error");
    expect(result.text).toContain("quota exceeded");
  });
});

describe("agent runtime native transports", () => {
  const request = {
    model: "model",
    text: "",
    history: [],
    attachments: [{ mimeType: "image/png", data: "abc" }],
    stream: false,
  } as const;

  it("keeps image-only turns in OpenAI, Gemini, and Responses payloads", () => {
    const openAi = new OpenAIChatTransport().buildRequest({
      request,
      baseUrl: "https://x/v1",
      headers: {},
    });
    const gemini = new GeminiTransport().buildRequest({
      request,
      baseUrl: "https://x/v1",
      headers: {},
    });
    const responses = new OpenAIResponsesTransport().buildRequest({
      request,
      baseUrl: "https://x/v1",
      headers: {},
    });
    expect(openAi?.body.messages as Array<unknown>).toHaveLength(1);
    expect(gemini?.body.contents as Array<unknown>).toHaveLength(1);
    expect(responses?.body.input as Array<unknown>).toHaveLength(1);
  });

  it("does not duplicate Responses output_text and normalizes Gemini usage envelopes", () => {
    const responses = new OpenAIResponsesTransport();
    expect(
      responses.parseResponse({ output_text: "hello", output: [{ text: "hello" }] }).text,
    ).toBe("hello");
    expect(
      new GeminiTransport().normalizeUsage({ usageMetadata: { promptTokenCount: 3 } }),
    ).toEqual({ inputTokens: 3 });
  });

  it("keeps Anthropic tool argument deltas attached to their indexed call", () => {
    const transport = new AnthropicTransport();
    expect(
      transport.parseSseEvents(
        'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      ),
    ).toMatchObject([{ kind: "tool-call-delta", toolCallIndex: 2 }]);
  });
});
