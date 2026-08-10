/**
 * Math utilities module.
 *
 * BUG: The divide function incorrectly handles division by zero.
 * It should throw an error, but currently returns Infinity.
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

/**
 * BUG: This function should throw an error when divisor is zero,
 * but currently returns Infinity (JavaScript's default behavior).
 */
export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error("Division by zero");
  }
  return a / b;
}

export function factorial(n: number): number {
  if (n < 0) throw new Error("Negative numbers not supported");
  if (n === 0 || n === 1) return 1;
  return n * factorial(n - 1);
}

export function fibonacci(n: number): number {
  if (n < 0) throw new Error("Negative numbers not supported");
  if (n === 0) return 0;
  if (n === 1) return 1;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
