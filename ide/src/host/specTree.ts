// Spec TreeView — Layer 1 made visible (P2): the design's architectural
// contract (SPEC) plus the oracle status row showing what runs are graded
// against.

import * as vscode from 'vscode';

import type { SpecDocument } from '@iss/contracts/spec';
import type { SailStatus } from '@iss/contracts/messaging';

type Row =
  | { kind: 'none' }
  | { kind: 'meta' }
  | { kind: 'oracle' }
  | { kind: 'group'; label: string }
  | { kind: 'state'; index: number }
  | { kind: 'op'; index: number };

export class SpecProvider implements vscode.TreeDataProvider<Row> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private spec: SpecDocument | null,
    private sail: SailStatus,
  ) {}

  update(spec: SpecDocument | null, sail: SailStatus): void {
    this.spec = spec;
    this.sail = sail;
    this.emitter.fire();
  }

  getChildren(element?: Row): Row[] {
    if (!this.spec) return element ? [] : [{ kind: 'none' }];
    if (!element) {
      return [
        { kind: 'meta' },
        { kind: 'oracle' },
        { kind: 'group', label: 'Architectural State' },
        { kind: 'group', label: 'Operations' },
      ];
    }
    if (element.kind === 'group' && element.label === 'Architectural State')
      return this.spec.state.map((_, index) => ({ kind: 'state', index }));
    if (element.kind === 'group' && element.label === 'Operations')
      return this.spec.operations.map((_, index) => ({ kind: 'op', index }));
    return [];
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const spec = this.spec;
    switch (row.kind) {
      case 'none': {
        const item = new vscode.TreeItem('No spec yet — open the canvas → ⚙ Spec');
        item.iconPath = new vscode.ThemeIcon('info');
        item.command = { command: 'iss2.openCanvas', title: 'Open canvas' };
        return item;
      }
      case 'meta': {
        const harts = spec!.lanes?.harts ?? 1;
        const item = new vscode.TreeItem(`${spec!.name}`);
        item.description = `${spec!.kind}${spec!.xlen ? ` · xlen ${spec!.xlen}` : ''}${
          harts > 1 ? ` · ${harts} harts` : ''
        }`;
        item.iconPath = new vscode.ThemeIcon('book');
        return item;
      }
      case 'oracle': {
        const { ref, lastRun, why } = this.sail;
        const checked = spec!.operations.filter((o) => o.oracle).length;
        const status = lastRun
          ? lastRun.ok
            ? `matched ${lastRun.matched}`
            : `DIVERGED after ${lastRun.matched}`
          : 'not run';
        const item = new vscode.TreeItem(`Reference oracle: ${ref} (${status})`);
        item.description = `${checked}/${spec!.operations.length} ops oracle-checked`;
        item.iconPath = new vscode.ThemeIcon(
          lastRun ? (lastRun.ok ? 'verified' : 'error') : checked > 0 ? 'question' : 'warning',
        );
        item.tooltip =
          why ??
          `Runs are graded against the ${ref} reference model. Operations without the oracle ` +
            `badge are spec-only until the oracle is regenerated.`;
        item.command = { command: 'iss2.verifyAgainstSail', title: 'Verify' };
        return item;
      }
      case 'group':
        return new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.Expanded);
      case 'state': {
        const s = spec!.state[row.index];
        const item = new vscode.TreeItem(s.name);
        item.description = `${s.label} — ${s.count ? `${s.count}×` : ''}${s.bits}b${
          s.space ? ` [${s.space}]` : ''
        }`;
        item.iconPath = new vscode.ThemeIcon('symbol-field');
        return item;
      }
      case 'op': {
        const o = spec!.operations[row.index];
        const item = new vscode.TreeItem(o.oracle ? o.mnemonic : `★ ${o.mnemonic}`);
        item.description = `${o.format ? `${o.format} — ` : ''}${o.summary}${
          o.oracle ? ' ✓oracle' : ' (spec-only)'
        }`;
        item.iconPath = new vscode.ThemeIcon(o.oracle ? 'verified' : 'star-full');
        item.tooltip = o.semantics ?? o.summary;
        return item;
      }
    }
  }
}
