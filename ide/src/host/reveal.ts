// Click a block → open its real source in a native editor column (no webview
// editor, per the standing decision).
//
// Which file and line to open is a property of the design, not of the editor,
// so it lives in @iss/host and the desktop app resolves it identically. What
// stays here is only the VS Code way of showing it.

import * as vscode from 'vscode';

import { resolveBlockSource } from '@iss/host';
import type { GraphComponent, SourceRange } from '@iss/contracts/graph';

/** Open a file at a 1-based line in the second column, centered. */
async function openAt(file: string, line: number, col = 1): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Two,
    preserveFocus: false,
  });
  const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, col - 1));
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/** Open a specific source range (used for event/message declarations). */
export async function revealRange(range: SourceRange): Promise<void> {
  await openAt(range.file, range.line, range.col);
}

export async function revealBlock(comp: GraphComponent, projectRoot: string): Promise<void> {
  const at = resolveBlockSource(comp, projectRoot);
  if (!at) return;
  await openAt(at.file, at.line);
}
