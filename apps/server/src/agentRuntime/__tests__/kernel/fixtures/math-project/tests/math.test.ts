import { describe, it, expect } from "vite-plus/test";
import { add, subtract, multiply, divide, factorial, fibonacci } from "../src/math.js";

describe("Math utilities", () => {
  describe("add", () => {
    it("adds two positive numbers", () => {
      expect(add(2, 3)).toBe(5);
    });

    it("handles negative numbers", () => {
      expect(add(-1, -2)).toBe(-3);
    });

    it("handles zero", () => {
      expect(add(0, 5)).toBe(5);
    });
  });

  describe("subtract", () => {
    it("subtracts two numbers", () => {
      expect(subtract(5, 3)).toBe(2);
    });

    it("handles negative results", () => {
      expect(subtract(3, 5)).toBe(-2);
    });
  });

  describe("multiply", () => {
    it("multiplies two numbers", () => {
      expect(multiply(3, 4)).toBe(12);
    });

    it("handles zero", () => {
      expect(multiply(5, 0)).toBe(0);
    });
  });

  describe("divide", () => {
    it("divides two numbers", () => {
      expect(divide(10, 2)).toBe(5);
    });

    it("handles decimal results", () => {
      expect(divide(10, 3)).toBeCloseTo(3.333, 2);
    });

    /**
     * BUG TEST: This test currently fails because divide() returns Infinity
     * instead of throwing an error when dividing by zero.
     *
     * The agent should:
     * 1. Read the source file
     * 2. Understand the bug
     * 3. Fix divide() to throw on zero divisor
     * 4. Verify the test passes
     */
    it("throws error when dividing by zero", () => {
      expect(() => divide(10, 0)).toThrow("Division by zero");
    });
  });

  describe("factorial", () => {
    it("calculates factorial of 0", () => {
      expect(factorial(0)).toBe(1);
    });

    it("calculates factorial of 5", () => {
      expect(factorial(5)).toBe(120);
    });

    it("throws for negative numbers", () => {
      expect(() => factorial(-1)).toThrow("Negative numbers not supported");
    });
  });

  describe("fibonacci", () => {
    it("returns 0 for n=0", () => {
      expect(fibonacci(0)).toBe(0);
    });

    it("returns 1 for n=1", () => {
      expect(fibonacci(1)).toBe(1);
    });

    it("returns 5 for n=5", () => {
      expect(fibonacci(5)).toBe(5);
    });

    it("throws for negative numbers", () => {
      expect(() => fibonacci(-1)).toThrow("Negative numbers not supported");
    });
  });
});
