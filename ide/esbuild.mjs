import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const host = {
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: ['src/webview/index.tsx'],
  outfile: 'media/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  sourcemap: true,
  loader: { '.css': 'css' },
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview)]);
  console.log('built out/extension.js + media/webview.js');
}
