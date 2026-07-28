// Verilator --cc step for co-simulation: each sv-impl leaf's twin is
// verilated into its own build/verilated/<id>/ model directory (unique
// --prefix per leaf, so duplicated composites whose leaves share a module
// name can coexist in one binary). The returned include dirs + sources feed
// straight into simulate()'s single g++ invocation — no verilator-generated
// makefiles involved.
//
// Cheap mtime cache: a leaf is re-verilated only when its .sv is newer than
// the generated V_<id>.h (verilation is the slow half of an SV run).

import * as fs from 'fs';
import * as path from 'path';

import { svPrefixOf } from '../writer/svadapter';
import { run } from './run';

export interface SvLeafRef {
  /** Full dot-path component id, e.g. "CPU0.DE". */
  id: string;
  /** Project-relative twin file, e.g. "src/CPU0/DE.sv". */
  svFile: string;
}

export interface VerilateResult {
  /** Project-relative include dirs (model dirs + verilator runtime). */
  includeDirs: string[];
  /** Project-relative / absolute .cpp files to add to the design compile. */
  sources: string[];
}

export async function verilateLeaves(
  projectRoot: string,
  leaves: SvLeafRef[],
  log: (line: string) => void,
): Promise<VerilateResult> {
  if (leaves.length === 0) return { includeDirs: [], sources: [] };

  let verilatorRoot = '';
  try {
    const rootRes = await run('verilator', ['--getenv', 'VERILATOR_ROOT'], {
      cwd: projectRoot,
      timeoutMs: 15_000,
    });
    if (rootRes.code === 0) verilatorRoot = rootRes.stdout.trim();
  } catch {
    // spawn failure (not installed) — handled below
  }
  if (!verilatorRoot)
    throw new Error(
      `verilator not available — install it to co-simulate the ${leaves.length} SV-impl block(s), ` +
        'or switch them back to C++ in the inspector',
    );

  const includeDirs: string[] = [];
  const sources: string[] = [];

  for (const leaf of leaves) {
    const prefix = svPrefixOf(leaf.id);
    const mdir = path.join('build', 'verilated', leaf.id.split('.').join('_'));
    const svAbs = path.join(projectRoot, leaf.svFile);
    const headerAbs = path.join(projectRoot, mdir, `${prefix}.h`);
    if (!fs.existsSync(svAbs)) throw new Error(`SV twin missing: ${leaf.svFile}`);

    // A cached model verilated before --trace was standard lacks the VCD
    // hooks (no V_<id>__Trace.cpp) — treat it as stale so it re-verilates once.
    const traceCppAbs = path.join(projectRoot, mdir, `${prefix}__Trace.cpp`);
    const fresh =
      fs.existsSync(headerAbs) &&
      fs.existsSync(traceCppAbs) &&
      fs.statSync(headerAbs).mtimeMs > fs.statSync(svAbs).mtimeMs;
    if (fresh) {
      log(`verilator: ${leaf.svFile} unchanged — model cached (${mdir})`);
    } else {
      // verilator does not create --Mdir parents itself.
      fs.mkdirSync(path.join(projectRoot, mdir), { recursive: true });
      const args = ['--cc', leaf.svFile, '--trace', '--prefix', prefix, '--Mdir', mdir, '-Isrc', '-Wno-fatal'];
      log(`verilator ${args.join(' ')}`);
      const res = await run('verilator', args, { cwd: projectRoot, timeoutMs: 60_000 }, log);
      if (res.code !== 0) throw new Error(`verilator failed for ${leaf.svFile} — see console`);
    }

    includeDirs.push(mdir);
    for (const name of fs.readdirSync(path.join(projectRoot, mdir)))
      if (name.endsWith('.cpp')) sources.push(path.join(mdir, name));
  }

  // The Verilator runtime, compiled into the same binary.
  const rtInclude = path.join(verilatorRoot, 'include');
  includeDirs.push(rtInclude, path.join(rtInclude, 'vltstd'));
  for (const rt of ['verilated.cpp', 'verilated_threads.cpp', 'verilated_vcd_c.cpp']) {
    const file = path.join(rtInclude, rt);
    if (fs.existsSync(file)) sources.push(file);
  }
  return { includeDirs, sources };
}
