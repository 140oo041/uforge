// Verilator lint for the SV twins — the "it's real" check on the co-sim
// contract. Best-effort: a missing verilator degrades to a console notice.

import * as fs from 'fs';
import * as path from 'path';

import { run } from './run';

export interface SvLintResult {
  file: string;
  ok: boolean;
  messages: string[];
}

export async function lintSv(
  projectRoot: string,
  files: string[],
  log: (line: string) => void,
): Promise<SvLintResult[]> {
  const existing = files.filter((f) => fs.existsSync(path.join(projectRoot, f)));
  if (existing.length === 0) return [];
  const results: SvLintResult[] = [];
  for (const file of existing) {
    const messages: string[] = [];
    try {
      const res = await run(
        'verilator',
        ['--lint-only', '-Wall', '-Isrc', file],
        { cwd: projectRoot, timeoutMs: 30_000 },
        (line) => {
          messages.push(line);
          log(`verilator: ${line}`);
        },
      );
      const ok = res.code === 0;
      log(`verilator --lint-only ${file} — ${ok ? 'clean ✓' : `FAILED (exit ${res.code})`}`);
      results.push({ file, ok, messages });
    } catch (err) {
      log(
        `verilator not available (${String(err instanceof Error ? err.message : err)}) — ` +
          'SV lint skipped. Install verilator to check the twins.',
      );
      return results;
    }
  }
  return results;
}
