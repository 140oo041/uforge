// The single source of the parsed model, with no host API in it.
//
// The refresh contract that used to live in the extension is preserved exactly:
//  - unsaved editor text is fed in as a parser overlay and triggers a SHORT
//    debounce (120ms) so the canvas tracks typing;
//  - the per-file cache inside ProjectParser makes each refresh a single-file
//    re-scan plus pure assembly;
//  - a parse failure keeps the last good graph and is reported, never thrown at
//    the caller — losing the whole canvas because one file is mid-edit would
//    contradict "never hide a failure" by hiding everything else too.
//
// What is deliberately absent: file watching and editor events. Those are the
// one genuinely host-specific part, so each host (VS Code's FileSystemWatcher,
// Electron's chokidar) drives this store rather than being embedded in it.

import { EMPTY_GRAPH, type Graph, type GraphComponent } from '@iss/contracts/graph';
import { ProjectParser } from '../parser';

/** Source files the parser reads — the watch set for any host. */
export const SOURCE_EXTENSIONS = ['h', 'hpp', 'hh', 'cpp', 'cc', 'cxx'] as const;

const SOURCE_RE = new RegExp(`\\.(${SOURCE_EXTENSIONS.join('|')})$`);

/** Glob a host can hand to its own watcher, so the watch set is defined once. */
export const SOURCE_GLOB = `**/*.{${SOURCE_EXTENSIONS.join(',')}}`;

export interface GraphStoreEvents {
  /** A new graph was parsed successfully. */
  onGraph(graph: Graph): void;
  /** A parse attempt failed; the previous graph is still current. */
  onParseError(message: string): void;
}

export class GraphStore {
  private parser: ProjectParser;
  private graph: Graph = EMPTY_GRAPH;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners: Array<Partial<GraphStoreEvents>> = [];

  constructor(private root: string) {
    this.parser = new ProjectParser([root]);
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(events: Partial<GraphStoreEvents>): () => void {
    this.listeners.push(events);
    return () => {
      const i = this.listeners.indexOf(events);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  get current(): Graph {
    return this.graph;
  }

  blockById(id: string): GraphComponent | undefined {
    return this.graph.components.find((c) => c.id === id);
  }

  /** Is this path one of the project's sources? Hosts use it to filter events. */
  isProjectSource(file: string): boolean {
    return file.startsWith(this.root) && SOURCE_RE.test(file);
  }

  /** Unsaved editor text for a file, or null to fall back to what's on disk. */
  setOverlay(file: string, text: string | null): void {
    this.parser.setOverlay(file, text);
  }

  /** A file changed on disk — drop its cache entry and re-parse soon. */
  invalidate(file: string): void {
    this.parser.invalidate(file);
    this.schedule(120);
  }

  /** Coalesce bursts of edits into one re-parse. */
  schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reparse(), delayMs);
  }

  reparse(): void {
    try {
      this.graph = this.parser.parse();
      for (const l of this.listeners) l.onGraph?.(this.graph);
    } catch (err) {
      const message = `reparse failed — keeping the previous graph. ${String(err)}`;
      for (const l of this.listeners) l.onParseError?.(message);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.listeners = [];
  }
}
