// parseProject: project roots → Graph, with a per-file incremental cache.
//
// v2 refresh contract (DESIGN_PLAN v3 P1): the host feeds this from a
// debounced onDidChangeTextDocument with in-memory overlays, and only the
// changed file's facts are re-extracted — everything else is reused, so a
// keystroke-to-canvas refresh is a single-file scan + pure assembly.

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

import type { Graph } from '@iss/contracts/graph';
import { assembleGraph } from './infer';
import { extractFacts, type FileFacts } from './facts';

const CPP_EXT = new Set(['.h', '.hpp', '.hh', '.cpp', '.cc', '.cxx']);
const SKIP_DIRS = new Set(['node_modules', 'build', 'out']);

export function collectSources(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (CPP_EXT.has(path.extname(entry.name))) {
        files.push(full);
      }
    }
  };
  // Prefer the design layout (inc/ + src/) when present, so a root that also
  // contains vendored trees doesn't drown the parse.
  const inc = path.join(root, 'inc');
  const src = path.join(root, 'src');
  if (fs.existsSync(inc) || fs.existsSync(src)) {
    if (fs.existsSync(inc)) walk(inc);
    if (fs.existsSync(src)) walk(src);
  } else {
    walk(root);
  }
  return files.sort();
}

interface CacheEntry {
  hash: string;
  facts: FileFacts;
}

export class ProjectParser {
  private cache = new Map<string, CacheEntry>();
  /** Unsaved editor contents, keyed by absolute path. */
  private overlays = new Map<string, string>();

  constructor(private roots: string[]) {}

  setRoots(roots: string[]): void {
    this.roots = roots;
    this.cache.clear();
  }

  /** Feed unsaved editor text (live refresh). null clears the overlay. */
  setOverlay(file: string, content: string | null): void {
    const key = path.resolve(file);
    if (content === null) this.overlays.delete(key);
    else this.overlays.set(key, content);
    this.cache.delete(key);
  }

  /** Drop a single file's cache (watcher change/create/delete). */
  invalidate(file: string): void {
    this.cache.delete(path.resolve(file));
  }

  parse(): Graph {
    const files = new Set<string>();
    for (const root of this.roots)
      for (const file of collectSources(root)) files.add(path.resolve(file));
    for (const file of this.overlays.keys()) files.add(file);

    const allFacts: FileFacts[] = [];
    for (const file of files) {
      const overlay = this.overlays.get(file);
      let content: string;
      if (overlay !== undefined) {
        content = overlay;
      } else {
        try {
          content = fs.readFileSync(file, 'utf8');
        } catch {
          this.cache.delete(file);
          continue;
        }
      }
      const hash = createHash('sha1').update(content).digest('hex');
      const cached = this.cache.get(file);
      if (cached && cached.hash === hash) {
        allFacts.push(cached.facts);
      } else {
        const facts = extractFacts(file, content);
        this.cache.set(file, { hash, facts });
        allFacts.push(facts);
      }
    }
    // Files that disappeared: prune cache entries not seen this pass.
    for (const key of this.cache.keys()) if (!files.has(key)) this.cache.delete(key);

    return assembleGraph(allFacts);
  }
}

/** One-shot convenience used by tests and scripts. */
export function parseProject(roots: string[]): Graph {
  return new ProjectParser(roots).parse();
}
