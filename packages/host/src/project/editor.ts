// Open a block's source in the user's real editor.
//
// The standing product decision is that the canvas is never a text editor, and
// the desktop app keeps it: double-clicking a block hands the file to whatever
// the architect already works in. Until now that meant `shell.openPath`, which
// defers to the OS file association — it opens *a* program, at the top of the
// file, with no idea which line you meant.
//
// This drives VS Code properly instead: `--goto file:line:col` lands the cursor
// on the handler you clicked, and `--reuse-window` puts it in the window
// already open rather than spawning another one. Under WSL the `code` on PATH
// is the remote CLI, so this reaches the user's real Windows VS Code across the
// boundary for free.
//
// Detection is honest: if nothing is found we say so and name the fallback,
// rather than silently doing nothing when a block is double-clicked.

import { spawn, spawnSync } from 'child_process';

import type { SourceLocation } from './source';

export interface EditorTarget {
  /** Stable id — also what ISS_EDITOR accepts. */
  id: string;
  /** What to show a human: "VS Code", "Cursor". */
  label: string;
  /** The resolved executable or command name. */
  command: string;
}

/** Preference order. `code` first: it is the one the product is designed around. */
const CANDIDATES: Array<{ id: string; label: string; command: string }> = [
  { id: 'code', label: 'VS Code', command: 'code' },
  { id: 'code-insiders', label: 'VS Code Insiders', command: 'code-insiders' },
  { id: 'cursor', label: 'Cursor', command: 'cursor' },
  { id: 'codium', label: 'VSCodium', command: 'codium' },
  { id: 'code-oss', label: 'Code - OSS', command: 'code-oss' },
];

function onPath(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Find the editor to hand files to.
 *
 * `ISS_EDITOR` wins and may be either a known id or an absolute path to any
 * VS Code-compatible binary — an architect with a bespoke build should not have
 * to be in our list to be supported.
 */
export function detectEditor(): EditorTarget | null {
  const override = process.env.ISS_EDITOR?.trim();
  if (override) {
    const known = CANDIDATES.find((c) => c.id === override);
    if (known && onPath(known.command)) return known;
    // An explicit path is taken at its word: if the user named it, use it.
    return { id: 'custom', label: override.split(/[/\\]/).pop() || override, command: override };
  }
  for (const c of CANDIDATES) if (onPath(c.command)) return c;
  return null;
}

function launch(command: string, args: string[]): void {
  // Detached and fully unref'd: the editor outlives this app, and a long-lived
  // child holding a pipe would keep the process from exiting cleanly.
  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
  child.unref();
}

/** Open one file at a 1-based line, in the window the user already has open. */
export function openInEditor(editor: EditorTarget, at: SourceLocation): void {
  launch(editor.command, ['--reuse-window', '--goto', `${at.file}:${Math.max(1, at.line)}:1`]);
}

/** Open the whole design directory as a workspace folder. */
export function openFolderInEditor(editor: EditorTarget, dir: string): void {
  launch(editor.command, ['--reuse-window', dir]);
}
