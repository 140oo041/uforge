// VS Code's half of the graph store: watchers in, events out.
//
// The parse contract itself (debounce windows, the overlay for unsaved text,
// keeping the last good graph on failure) lives in @iss/host and is shared with
// the desktop app. What is genuinely VS Code here is only how change arrives —
// a FileSystemWatcher and the text-document events — and how it leaves, as a
// vscode.Event the trees and the panel already subscribe to.

import * as vscode from 'vscode';

import { GraphStore as CoreGraphStore, SOURCE_GLOB } from '@iss/host';
import type { Graph, GraphComponent } from '@iss/contracts/graph';

export class GraphStore implements vscode.Disposable {
  private core: CoreGraphStore;
  private emitter = new vscode.EventEmitter<Graph>();
  private disposables: vscode.Disposable[] = [];

  readonly onDidChange = this.emitter.event;

  constructor(root: string) {
    this.core = new CoreGraphStore(root);

    this.disposables.push(
      { dispose: this.core.subscribe({
          onGraph: (graph) => this.emitter.fire(graph),
          onParseError: (message) => void vscode.window.showErrorMessage(`ISS: ${message}`),
        }) },
    );

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, SOURCE_GLOB),
    );
    watcher.onDidChange((uri) => this.core.invalidate(uri.fsPath));
    watcher.onDidCreate((uri) => this.core.invalidate(uri.fsPath));
    watcher.onDidDelete((uri) => this.core.invalidate(uri.fsPath));
    this.disposables.push(watcher);

    // Live refresh: parse unsaved editor text, not just saved files.
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!this.core.isProjectSource(e.document.uri.fsPath)) return;
        this.core.setOverlay(e.document.uri.fsPath, e.document.getText());
        this.core.schedule(120);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!this.core.isProjectSource(doc.uri.fsPath)) return;
        this.core.setOverlay(doc.uri.fsPath, null);
        this.core.schedule(50);
      }),
    );
  }

  get current(): Graph {
    return this.core.current;
  }

  blockById(id: string): GraphComponent | undefined {
    return this.core.blockById(id);
  }

  reparse(): void {
    this.core.reparse();
  }

  dispose(): void {
    this.core.dispose();
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}
