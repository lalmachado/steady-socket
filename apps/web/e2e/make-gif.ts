/**
 * Turns the frames of a recorded run (`RECORD_DIR=<dir> pnpm e2e`) into a GIF with ffmpeg.
 *
 *   pnpm --filter @steady-socket/demo-web exec tsx e2e/make-gif.ts <frames-dir> <out.gif> [trim-end-seconds]
 *
 * Each frame's file name ends in the time it was taken, in ms, so the GIF keeps the real pacing.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [framesDir, output, trim = '0'] = process.argv.slice(2);
if (!framesDir || !output) {
  console.error('Usage: make-gif.ts <frames-dir> <out.gif> [trim-end-seconds]');
  process.exit(1);
}

const frames = readdirSync(framesDir)
  .filter((name) => name.endsWith('.png'))
  .sort()
  .map((name) => ({ name, at: Number(/-(\d+)\.png$/.exec(name)?.[1] ?? Number.NaN) }));
if (frames.length === 0 || frames.some((frame) => Number.isNaN(frame.at))) {
  throw new Error(`No frames named <index>-<ms>.png in ${framesDir}.`);
}

// Drop the end of the run (for example a check that shows nothing on screen).
const last = frames[frames.length - 1];
if (!last) throw new Error('unreachable');
const keep = frames.filter((frame) => frame.at <= last.at - Number(trim) * 1000);

// ffmpeg's concat format takes one duration per frame: the time until the next frame.
const lines = ['ffconcat version 1.0'];
keep.forEach((frame, index) => {
  const next = keep[index + 1]?.at ?? frame.at + 500;
  const seconds = Math.min(Math.max((next - frame.at) / 1000, 0.02), 0.6);
  lines.push(`file '${join(framesDir, frame.name)}'`, `duration ${seconds.toFixed(3)}`);
});
const lastKept = keep[keep.length - 1];
if (lastKept) lines.push(`file '${join(framesDir, lastKept.name)}'`);

const list = join(mkdtempSync(join(tmpdir(), 'steady-socket-gif-')), 'frames.ffconcat');
writeFileSync(list, `${lines.join('\n')}\n`);

// A flat UI needs no dithering, and a full palette keeps the small bright colours (red, blue).
const filter =
  'fps=12,scale=860:-1:flags=lanczos,split[a][b];' +
  '[a]palettegen=max_colors=200:stats_mode=full[p];[b][p]paletteuse=dither=none';
execFileSync(
  'ffmpeg',
  [
    '-v',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    filter,
    '-loop',
    '0',
    output,
  ],
  {
    stdio: 'inherit',
  },
);
console.log(`Wrote ${output} from ${String(keep.length)} frames.`);
