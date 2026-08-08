import { describe, expect, it } from "@effect/vitest";

import {
  readCommandCodeSessionId,
  resultStopState,
  runtimeModeArgs,
  usageSnapshot,
} from "./CommandCodeAdapter.ts";

describe("CommandCode adapter protocol helpers", () => {
  describe("readCommandCodeSessionId", () => {
    it("accepts only usable resume cursor shapes", () => {
      expect(readCommandCodeSessionId(" session-123 ")).toBe("session-123");
      expect(readCommandCodeSessionId({ sessionId: " session-456 " })).toBe("session-456");
      expect(readCommandCodeSessionId({ sessionId: "   " })).toBeUndefined();
      expect(readCommandCodeSessionId({ id: "session-789" })).toBeUndefined();
      expect(readCommandCodeSessionId(null)).toBeUndefined();
    });

    it("handles undefined input", () => {
      expect(readCommandCodeSessionId(undefined)).toBeUndefined();
    });

    it("handles string input without spaces", () => {
      expect(readCommandCodeSessionId("session-123")).toBe("session-123");
    });

    it("handles record with empty string sessionId", () => {
      expect(readCommandCodeSessionId({ sessionId: "" })).toBeUndefined();
    });

    it("handles record with numeric sessionId", () => {
      expect(readCommandCodeSessionId({ sessionId: 123 })).toBeUndefined();
    });
  });

  describe("runtimeModeArgs", () => {
    it("maps T3 runtime modes to CommandCode permission flags", () => {
      expect(runtimeModeArgs("approval-required", false)).toEqual([
        "--permission-mode",
        "standard",
      ]);
      expect(runtimeModeArgs("auto-accept-edits", false)).toEqual([
        "--permission-mode",
        "auto-accept",
      ]);
      expect(runtimeModeArgs("full-access", false)).toEqual(["--yolo"]);
      expect(runtimeModeArgs("full-access", true)).toEqual(["--permission-mode", "plan"]);
    });

    it("handles auto mode (alias for auto-accept-edits)", () => {
      expect(runtimeModeArgs("auto", false)).toEqual(["--permission-mode", "auto-accept"]);
    });

    it("returns default flags for unknown runtime mode", () => {
      expect(runtimeModeArgs("unknown-mode" as never, false)).toEqual([
        "--permission-mode",
        "standard",
      ]);
    });

    it("plan flag overrides any runtime mode", () => {
      expect(runtimeModeArgs("full-access", true)).toEqual(["--permission-mode", "plan"]);
      expect(runtimeModeArgs("approval-required", true)).toEqual(["--permission-mode", "plan"]);
    });
  });

  describe("resultStopState", () => {
    it("classifies terminal results correctly", () => {
      expect(resultStopState({ type: "result", stopReason: "end_turn" })).toBe("completed");
      expect(resultStopState({ type: "result", subtype: "max_turns" })).toBe("completed");
      expect(resultStopState({ type: "result", stopReason: "max_turns" })).toBe("completed");
      expect(resultStopState(undefined)).toBe("failed");
      expect(resultStopState({ type: "result", subtype: "error" })).toBe("failed");
    });

    it("handles interrupted stop reasons", () => {
      expect(resultStopState({ type: "result", stopReason: "canceled" })).toBe("interrupted");
      expect(resultStopState({ type: "result", stopReason: "cancelled" })).toBe("interrupted");
      expect(resultStopState({ type: "result", stopReason: "interrupted" })).toBe("interrupted");
    });

    it("treats null/undefined/empty error as no error", () => {
      expect(resultStopState({ type: "result", error: null })).toBe("completed");
      expect(resultStopState({ type: "result", error: undefined })).toBe("completed");
      expect(resultStopState({ type: "result", error: "" })).toBe("completed");
      expect(resultStopState({ type: "result", error: false })).toBe("completed");
    });

    it("treats non-empty string error as failure", () => {
      expect(resultStopState({ type: "result", error: "something went wrong" })).toBe("failed");
    });

    it("error takes priority over stopReason", () => {
      expect(
        resultStopState({ type: "result", stopReason: "end_turn", error: "auth expired" }),
      ).toBe("failed");
    });

    it("completed result with no stopReason and no error", () => {
      expect(resultStopState({ type: "result" })).toBe("completed");
    });
  });

  describe("usageSnapshot", () => {
    it("extracts all valid token fields", () => {
      expect(
        usageSnapshot({ totalTokens: 10, inputTokens: 4, outputTokens: 6, contextWindow: 100 }),
      ).toEqual({
        totalTokens: 10,
        inputTokens: 4,
        outputTokens: 6,
        maxTokens: 100,
      });
    });

    it("computes totalTokens from component fields when absent", () => {
      expect(usageSnapshot({ inputTokens: 3, outputTokens: 7 })).toEqual({
        totalTokens: 10,
        inputTokens: 3,
        outputTokens: 7,
      });
    });

    it("includes reasoningOutputTokens in computed total", () => {
      expect(usageSnapshot({ inputTokens: 2, outputTokens: 3, reasoningOutputTokens: 5 })).toEqual({
        totalTokens: 10,
        inputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 5,
      });
    });

    it("accepts fractional token counts", () => {
      expect(usageSnapshot({ totalTokens: 10.5, inputTokens: 4.5, outputTokens: 6 })).toEqual({
        totalTokens: 10.5,
        inputTokens: 4.5,
        outputTokens: 6,
      });
    });

    it("accepts totalTokens of 0", () => {
      expect(usageSnapshot({ totalTokens: 0 })).toEqual({ totalTokens: 0 });
    });

    it("uses total/tokens aliases for totalTokens", () => {
      expect(usageSnapshot({ total: 10, inputTokens: 4, outputTokens: 6 })).toEqual({
        totalTokens: 10,
        inputTokens: 4,
        outputTokens: 6,
      });
      expect(usageSnapshot({ tokens: 10, inputTokens: 4, outputTokens: 6 })).toEqual({
        totalTokens: 10,
        inputTokens: 4,
        outputTokens: 6,
      });
    });

    it("uses context_window alias for maxTokens", () => {
      expect(usageSnapshot({ totalTokens: 10, context_window: 100 })).toEqual({
        totalTokens: 10,
        maxTokens: 100,
      });
    });

    it("filters invalid token counts", () => {
      expect(usageSnapshot({ totalTokens: -1 })).toBeUndefined();
      expect(usageSnapshot({ totalTokens: "10" })).toBeUndefined();
      expect(usageSnapshot({ unrelated: 1 })).toBeUndefined();
      expect(usageSnapshot({ totalTokens: Infinity })).toBeUndefined();
      expect(usageSnapshot({ totalTokens: NaN })).toBeUndefined();
    });

    it("returns undefined when no valid total can be computed", () => {
      expect(usageSnapshot({ inputTokens: "bad", outputTokens: "bad" })).toBeUndefined();
    });

    it("returns undefined for non-object input", () => {
      expect(usageSnapshot(null)).toBeUndefined();
      expect(usageSnapshot("string")).toBeUndefined();
      expect(usageSnapshot([])).toBeUndefined();
    });
  });
});
