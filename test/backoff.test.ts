import { describe, expect, it } from 'vitest';
import { computeDelay, resolveReconnect } from '../src/backoff';

const options = (overrides = {}) =>
  resolveReconnect({ minDelay: 100, maxDelay: 1000, factor: 2, random: () => 0.5, ...overrides });

describe('computeDelay', () => {
  it('with no jitter, grows exponentially and stops at maxDelay', () => {
    const o = options({ jitter: 'none' });
    expect([0, 1, 2, 3, 4, 5].map((n) => computeDelay(n, o))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
  });

  it('with full jitter, picks a point between 0 and the ceiling', () => {
    expect(computeDelay(2, options({ random: () => 0 }))).toBe(0);
    expect(computeDelay(2, options({ random: () => 0.5 }))).toBe(200);
    expect(computeDelay(2, options({ random: () => 0.999 }))).toBeCloseTo(399.6);
  });

  it('keeps the ceiling capped even for huge attempt numbers', () => {
    expect(computeDelay(10_000, options({ jitter: 'none' }))).toBe(1000);
  });
});
