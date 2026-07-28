// Where does a block's source actually live?
//
// "Double-clicking a block opens its .cpp" is a product promise, and the answer
// is the same in every host — only the act of opening differs (a VS Code editor
// column, an Electron shell-open, an external $EDITOR). So the resolution lives
// here and the opening stays with whoever owns a window.
//
// Order matters: the handler definition is where the architect actually works,
// so it wins over the file that merely declares the class.

import * as fs from 'fs';
import * as path from 'path';

import type { GraphComponent } from '@iss/contracts/graph';

export interface SourceLocation {
  file: string;
  /** 1-based, matching SourceRange and every editor's own numbering. */
  line: number;
}

/**
 * Resolve the file and line to open for a block: its `handle()` body first,
 * then the conventional `src/<id>.cpp`, then wherever the class is declared.
 * Returns null only when the parser recovered no location at all.
 */
export function resolveBlockSource(
  comp: GraphComponent,
  projectRoot: string,
): SourceLocation | null {
  if (comp.handler) return { file: comp.handler.file, line: comp.handler.line };

  const bySource = path.join(projectRoot, 'src', `${comp.id}.cpp`);
  if (fs.existsSync(bySource)) return { file: bySource, line: 1 };

  if (comp.decl?.file) return { file: comp.decl.file, line: comp.decl.line };
  return null;
}
