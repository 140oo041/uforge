// Collects the per-block VCD files a co-sim run dumped into build/waves/
// (one per SV-impl leaf, written by the generated adapters) and parses them
// into WaveDocs for the webview's WAVES panel. Missing files are skipped —
// waves may be disabled, or a block may have flipped back to C++.

import * as fs from 'fs';
import * as path from 'path';

import type { WaveDoc } from '@iss/contracts/waves';
import { parseVcd } from '../trace/vcd';

export const WAVES_DIR = path.join('build', 'waves');

export function wavesFileFor(id: string): string {
  return path.join(WAVES_DIR, id.split('.').join('_') + '.vcd');
}

export function collectWaves(projectRoot: string, svLeafIds: string[]): WaveDoc[] {
  const docs: WaveDoc[] = [];
  for (const id of svLeafIds) {
    const file = path.join(projectRoot, wavesFileFor(id));
    if (!fs.existsSync(file)) continue;
    try {
      docs.push(parseVcd(fs.readFileSync(file, 'utf8'), id));
    } catch {
      // unreadable VCD — skip, never break the run flow
    }
  }
  return docs;
}

/** Drop stale VCDs so a run with waves off (or fewer SV blocks) can't show old data. */
export function clearWaves(projectRoot: string): void {
  const dir = path.join(projectRoot, WAVES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir))
    if (name.endsWith('.vcd')) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // locked/gone — the mkdir above still guarantees the dir exists
      }
    }
}
