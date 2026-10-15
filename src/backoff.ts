import type { ReconnectOptions } from './types';

export type ResolvedReconnect = Required<Omit<ReconnectOptions, 'maxAttempts'>> & {
  maxAttempts: number;
};

export function resolveReconnect(options: ReconnectOptions = {}): ResolvedReconnect {
  return {
    minDelay: options.minDelay ?? 500,
    maxDelay: options.maxDelay ?? 30_000,
    factor: options.factor ?? 2,
    jitter: options.jitter ?? 'full',
    maxAttempts: options.maxAttempts ?? Infinity,
    random: options.random ?? Math.random,
  };
}

/** Delay before retry number `attempt` (0 for the first retry), in ms. */
export function computeDelay(attempt: number, options: ResolvedReconnect): number {
  const ceiling = Math.min(options.maxDelay, options.minDelay * options.factor ** attempt);
  return options.jitter === 'full' ? options.random() * ceiling : ceiling;
}
