// Canvas node positions persist in a project sidecar (iss_layout.json), so a
// design opens where you left it — on any machine, not in one VS Code's
// workspaceState.

import * as fs from 'fs';
import * as path from 'path';

import type { LayoutMap } from '@iss/contracts/messaging';

export function layoutPath(projectRoot: string): string {
  return path.join(projectRoot, 'iss_layout.json');
}

export function loadLayout(projectRoot: string): LayoutMap {
  try {
    const raw = JSON.parse(fs.readFileSync(layoutPath(projectRoot), 'utf8')) as LayoutMap;
    const out: LayoutMap = {};
    for (const [id, pos] of Object.entries(raw)) {
      if (typeof pos?.x === 'number' && typeof pos?.y === 'number')
        out[id] = { x: pos.x, y: pos.y };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLayout(projectRoot: string, layout: LayoutMap): void {
  fs.writeFileSync(layoutPath(projectRoot), JSON.stringify(layout, null, 2) + '\n');
}
