// What VS Code's FileSystemWatcher did, in about forty lines of fs.watch.
//
// The extension gets change notification for free. Standing alone we watch the
// project tree ourselves — recursively where the platform supports it, and with
// an explicit per-directory fallback where it does not (Linux gives recursive
// fs.watch only on newer Node, so assuming it would silently stop tracking
// edits on exactly the platform this is being built on).
//
// Coalescing lives in the GraphStore, not here: it already debounces, so this
// forwards every event and lets the store decide when to re-parse.

import * as fs from 'fs';
import * as path from 'path';

import { SOURCE_EXTENSIONS } from '@iss/host';

const SOURCE_RE = new RegExp(`\\.(${SOURCE_EXTENSIONS.join('|')})$`);
const SPEC_FILES = new Set(['iss_spec.json', 'iss_isa.json']);
/** Never descend into these — build output churns constantly and parses to nothing. */
const IGNORED_DIRS = new Set(['build', 'node_modules', '.git', 'obj_dir']);

export interface WatcherEvents {
  onSourceChange(file: string): void;
  onSpecChange(file: string): void;
}

export class ProjectWatcher {
  private watchers: fs.FSWatcher[] = [];

  constructor(
    private root: string,
    private events: WatcherEvents,
  ) {
    try {
      this.watchers.push(
        fs.watch(root, { recursive: true }, (_e, name) => this.onChange(name)),
      );
    } catch {
      // No recursive support — walk the tree and watch each directory.
      this.watchDirectory(root);
    }
  }

  private watchDirectory(dir: string): void {
    try {
      this.watchers.push(
        fs.watch(dir, (_e, name) => this.onChange(name ? path.relative(this.root, path.join(dir, name)) : null)),
      );
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
        this.watchDirectory(path.join(dir, entry.name));
      }
    } catch {
      // A directory we cannot watch is not a reason to fail the session.
    }
  }

  private onChange(name: string | Buffer | null): void {
    if (!name) return;
    const rel = name.toString();
    if (rel.split(path.sep).some((seg) => IGNORED_DIRS.has(seg))) return;

    const file = path.join(this.root, rel);
    if (SOURCE_RE.test(rel)) this.events.onSourceChange(file);
    else if (SPEC_FILES.has(path.basename(rel))) this.events.onSpecChange(file);
  }

  dispose(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
