import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('README', () => {
  it('shows the code of examples/with-steady-socket.ts, which is type-checked and tested', () => {
    const readme = read('README.md');
    const shown = /```ts\n(import \{ browserLifecycle[\s\S]*?)```/.exec(readme)?.[1]?.trim();
    // The file starts with a comment about itself; the README shows only the code.
    const file = read('examples/with-steady-socket.ts')
      .replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
      .trim();
    expect(shown).toBe(file);
  });
});
