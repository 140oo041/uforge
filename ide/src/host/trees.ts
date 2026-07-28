// Explorer TreeViews: Blocks / Wires / Messages, driven by the GraphStore.

import * as vscode from 'vscode';

import type { Graph } from '@iss/contracts/graph';

abstract class GraphProvider<T> implements vscode.TreeDataProvider<T> {
  protected graph: Graph = { components: [], events: [], links: [], stubs: [] };
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  update(graph: Graph): void {
    this.graph = graph;
    this.emitter.fire();
  }

  abstract getChildren(element?: T): T[];
  abstract getTreeItem(element: T): vscode.TreeItem;
}

export class ComponentsProvider extends GraphProvider<string> {
  getChildren(parent?: string): string[] {
    return this.graph.components
      .filter((c) => c.parent === (parent ?? null))
      .map((c) => c.id);
  }
  getTreeItem(id: string): vscode.TreeItem {
    const comp = this.graph.components.find((c) => c.id === id)!;
    const composite = comp.kind === 'composite';
    const item = new vscode.TreeItem(
      comp.label,
      composite
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = comp.label === id ? undefined : id;
    item.iconPath = new vscode.ThemeIcon(composite ? 'server' : 'chip');
    item.command = { command: 'iss2.selectBlock', title: 'Select', arguments: [id] };
    item.tooltip = composite
      ? `composite — ${this.graph.components.filter((c) => c.parent === id).length} child block(s)`
      : `${comp.outPorts.length} out-port(s), consumes ${comp.consumes.join(', ') || '—'}` +
        (comp.vars.length ? `\nvars: ${comp.vars.join(', ')}` : '');
    return item;
  }
}

export class LinksProvider extends GraphProvider<string> {
  getChildren(): string[] {
    return [
      ...this.graph.links.map((l) => `link:${l.id}`),
      ...this.graph.stubs.map((s) => `stub:${s.from}.${s.port}`),
    ];
  }
  getTreeItem(key: string): vscode.TreeItem {
    if (key.startsWith('link:')) {
      const link = this.graph.links.find((l) => `link:${l.id}` === key)!;
      const arrow = link.status === 'wired' ? '→' : '⇢';
      const label = `${link.from}.${link.fromPort} ${arrow} ${link.to ?? '?'}`;
      const item = new vscode.TreeItem(label);
      item.description = `${link.message}${link.latency !== null ? ` · ${link.latency}cy` : ''}`;
      item.iconPath = new vscode.ThemeIcon(
        link.status === 'wired'
          ? 'arrow-right'
          : link.status === 'inferred'
            ? 'arrow-small-right'
            : 'warning',
      );
      return item;
    }
    const stub = this.graph.stubs.find((s) => `stub:${s.from}.${s.port}` === key)!;
    const item = new vscode.TreeItem(`${stub.from}.${stub.port} ⇢ ∅`);
    item.description = stub.reason;
    item.iconPath = new vscode.ThemeIcon('debug-disconnect');
    return item;
  }
}

export class EventsProvider extends GraphProvider<string> {
  getChildren(): string[] {
    return this.graph.events.map((e) => e.id);
  }
  getTreeItem(id: string): vscode.TreeItem {
    const event = this.graph.events.find((e) => e.id === id)!;
    const item = new vscode.TreeItem(id);
    item.description = event.fields.length ? `${event.fields.length} field(s)` : undefined;
    item.iconPath = new vscode.ThemeIcon('mail');
    item.tooltip = event.fields.join('\n');
    item.command = { command: 'iss2.revealEvent', title: 'Open message', arguments: [id] };
    return item;
  }
}
