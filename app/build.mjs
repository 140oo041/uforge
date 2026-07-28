// Three bundles, one bundler — the same esbuild the extension uses.
//
//   dist/electron/main.cjs      Node, has fs/child_process, owns the project
//   dist/electron/preload.cjs   the only code both sides can see
//   dist/renderer/*             the browser half: @iss/canvas and nothing else
//
// The split is a security boundary, not a build convenience: the renderer runs
// with contextIsolation and no Node integration, so a design's C++ can never
// reach the filesystem through the view. Everything it wants goes as a ViewMsg
// through the preload bridge and is serviced in main.

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const watch = process.argv.includes('--watch');

/** The HTML shell is static — copy it beside the bundle esbuild emits. */
function copyShell() {
  fs.mkdirSync('dist/renderer', { recursive: true });
  fs.copyFileSync('renderer.html', path.join('dist/renderer', 'index.html'));
}

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const main = {
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist/electron/main.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // Electron resolves these from its own runtime, never from node_modules.
  external: ['electron'],
};

/** @type {import('esbuild').BuildOptions} */
const preload = {
  ...common,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist/electron/preload.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron'],
};

/** @type {import('esbuild').BuildOptions} */
const renderer = {
  ...common,
  entryPoints: ['src/main.tsx'],
  outfile: 'dist/renderer/renderer.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.css': 'css' },
};

copyShell();

if (watch) {
  const contexts = await Promise.all(
    [main, preload, renderer].map((c) => esbuild.context(c)),
  );
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching — run `npm start` in another shell to launch the window');
} else {
  await Promise.all([main, preload, renderer].map((c) => esbuild.build(c)));
  console.log('built dist/electron + dist/renderer');
}
