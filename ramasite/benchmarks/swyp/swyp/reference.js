"use strict";
// Same scalar float64 algorithms and timed region as reference.c / compute.swyp.
// Each invocation is a fresh Node process; JIT compilation is NOT pre-warmed.
const { performance } = require("node:perf_hooks");
function mandelbrot(width) {
  const height = width / 2;
  let py = 0, checksum = 0;
  while (py < height) {
    let px = 0;
    while (px < width) {
      const cr = px * 3.5 / width - 2.5, ci = py * 2 / height - 1;
      let zr = 0, zi = 0, count = 0;
      while (count < 80 && zr * zr + zi * zi <= 4) {
        const next = zr * zr - zi * zi + cr;
        zi = 2 * zr * zi + ci; zr = next; count = count + 1;
      }
      checksum = checksum + count; px = px + 1;
    }
    py = py + 1;
  }
  return checksum;
}
function prime(n) {
  let divisor = 2;
  while (divisor * divisor <= n) {
    if (n % divisor === 0) return false;
    divisor = divisor + 1;
  }
  return true;
}
function primes(limit) {
  let n = 2, count = 0;
  while (n <= limit) {
    if (prime(n)) count = count + 1;
    n = n + 1;
  }
  return count;
}
function train(epochs) {
  let weight = 0, bias = 0, epoch = 0;
  while (epoch < epochs) {
    let dw = 0, db = 0, i = 0;
    while (i < 256) {
      const x = (i % 64) / 32 - 1, target = 2 * x + 1;
      const error = weight * x + bias - target;
      dw = dw + 2 * error * x; db = db + 2 * error; i = i + 1;
    }
    weight = weight - 0.1 * dw / 256;
    bias = bias - 0.1 * db / 256; epoch = epoch + 1;
  }
  let loss = 0, i = 0;
  while (i < 256) {
    const x = (i % 64) / 32 - 1, error = weight * x + bias - (2 * x + 1);
    loss = loss + error * error; i = i + 1;
  }
  loss = loss / 256;
  console.log("WEIGHTS", weight, bias, loss);
  return loss;
}
const input = process.argv.slice(2).map(Number);
if (input.length !== 2 || !input.every(Number.isFinite) || ![0, 1, 2].includes(input[0]) || input[1] <= 0) {
  console.error("usage: node reference.js <mode:0|1|2> <positive-size>");
  process.exit(2);
}
const [mode, size] = input;
const start = performance.now();
const value = (mode === 0 ? mandelbrot : mode === 1 ? primes : train)(size);
console.log("RESULT", (performance.now() - start) / 1000, value);
