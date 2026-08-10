/**
 * OutputTruncator — prevents giant tool outputs from consuming context.
 *
 * Never put 94,000 characters of npm test output directly back into context.
 * Instead, summarize and offer to show more.
 *
 * @module agentRuntime/kernel/OutputTruncator
 */

export interface TruncationConfig {
  /** Maximum characters for a single tool output. */
  readonly maxOutputChars: number;
  /** Maximum lines to keep from the end (for logs/test output). */
  readonly maxTailLines: number;
  /** Characters to reserve for the truncation notice. */
  readonly noticeOverhead: number;
}

const DEFAULT_CONFIG: TruncationConfig = {
  maxOutputChars: 8_000,
  maxTailLines: 100,
  noticeOverhead: 200,
};

export interface TruncatedOutput {
  /** The (possibly truncated) output. */
  readonly output: string;
  /** Whether truncation occurred. */
  readonly truncated: boolean;
  /** Original size in characters. */
  readonly originalSize: number;
  /** Final size in characters. */
  readonly finalSize: number;
  /** What was removed, if anything. */
  readonly summary?: string | undefined;
}

export class OutputTruncator {
  private readonly config: TruncationConfig;

  constructor(config?: Partial<TruncationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Truncate a tool output if needed.
   *
   * Invariants:
   * - Output is unchanged when it fits within `maxOutputChars`.
   * - When truncated, the content always fits within `maxOutputChars - noticeOverhead`,
   *   so the output is never larger than the input and stays near the budget.
   * - The most relevant content (tail) is always preserved.
   */
  truncate(output: string): TruncatedOutput {
    const originalSize = output.length;

    if (originalSize <= this.config.maxOutputChars) {
      return {
        output,
        truncated: false,
        originalSize,
        finalSize: originalSize,
      };
    }

    const targetSize = Math.max(50, this.config.maxOutputChars - this.config.noticeOverhead);
    const separator = "\n\n... [truncated] ...\n\n";
    const tailLines = this.extractTail(output, this.config.maxTailLines);

    let content: string;
    let strategy: "tail" | "head+tail";

    if (tailLines.length + separator.length <= targetSize) {
      // Head + tail fits within budget
      const headerSize = targetSize - tailLines.length - separator.length;
      content = output.slice(0, headerSize) + separator + tailLines;
      strategy = "head+tail";
    } else {
      // Tail alone is too big — keep the end of the tail that fits
      const marker = "\n... [output truncated, showing tail] ...\n";
      const keep = Math.max(0, targetSize - marker.length);
      content = marker + tailLines.slice(-keep);
      strategy = "tail";
    }

    const summary = this.buildSummary(originalSize, content.length, strategy);
    return {
      output: content + "\n\n" + summary,
      truncated: true,
      originalSize,
      finalSize: content.length + summary.length,
      summary,
    };
  }

  /**
   * Truncate test output specifically (keep failures, remove passes).
   */
  truncateTestOutput(output: string): TruncatedOutput {
    const originalSize = output.length;

    if (originalSize <= this.config.maxOutputChars) {
      return {
        output,
        truncated: false,
        originalSize,
        finalSize: originalSize,
      };
    }

    // Extract test summary and failures
    const lines = output.split("\n");
    const summaryLines: string[] = [];
    const failureLines: string[] = [];
    let inFailure = false;

    for (const line of lines) {
      if (line.includes("FAIL") || line.includes("✓") || line.includes("✗") || line.includes("×")) {
        summaryLines.push(line);
      }
      if (line.includes("FAIL") || line.includes("Error:") || line.includes("expected")) {
        inFailure = true;
      }
      if (inFailure) {
        failureLines.push(line);
      }
      if (inFailure && line.trim() === "") {
        inFailure = false;
      }
    }

    const summary = [...summaryLines, "", "--- FAILURES ---", ...failureLines].join("\n");

    if (summary.length <= this.config.maxOutputChars) {
      const notice = `\n\n[Truncated from ${originalSize} chars — showing summary + failures]`;
      const output = summary + notice;
      return {
        output,
        truncated: true,
        originalSize,
        finalSize: output.length,
        summary: `Extracted ${summaryLines.length} summary lines, ${failureLines.length} failure lines`,
      };
    }

    // Even the summary is too big, just take tail
    return this.truncate(summary);
  }

  /**
   * Truncate diff output (keep file headers, truncate large hunks).
   */
  truncateDiff(output: string): TruncatedOutput {
    const originalSize = output.length;

    if (originalSize <= this.config.maxOutputChars) {
      return {
        output,
        truncated: false,
        originalSize,
        finalSize: originalSize,
      };
    }

    // Split by file headers
    const files = output.split(/^(?=diff --git)/m);
    const kept: string[] = [];
    let totalSize = 0;

    for (const file of files) {
      if (totalSize + file.length > this.config.maxOutputChars) {
        // Truncate this file's diff
        const remaining = this.config.maxOutputChars - totalSize;
        if (remaining > 200) {
          kept.push(file.slice(0, remaining) + "\n... [diff truncated]");
        }
        break;
      }
      kept.push(file);
      totalSize += file.length;
    }

    const truncated = kept.join("\n");
    const result = truncated + `\n\n[Truncated from ${originalSize} chars — ${files.length} files]`;
    return {
      output: result,
      truncated: true,
      originalSize,
      finalSize: result.length,
      summary: `Kept ${kept.length} of ${files.length} file diffs`,
    };
  }

  private extractTail(text: string, maxLines: number): string {
    const lines = text.split("\n");
    return lines.slice(-maxLines).join("\n");
  }

  private buildSummary(original: number, final: number, strategy: string): string {
    const removed = original - final;
    const pct = Math.round((removed / original) * 100);
    return `[Output truncated: ${original.toLocaleString()} → ${final.toLocaleString()} chars (${pct}% removed, strategy: ${strategy}). Ask to see more if needed.]`;
  }
}
