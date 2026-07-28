// Run integration — two honest halves:
//
//  simulate(): the OWN-ENGINE path. Generates the harness, compiles the
//  project's blocks + harness against the micro_arch_ide2 engine (plain g++,
//  no Makefile required), runs it, and parses the real per-hop trace. This is
//  live animation from a real run — no synthetic fallback needed when it
//  succeeds.
//
//  verify(): the ISA cross-check. Spawns xverify --json (default --ref sail,
//  falling back to stub WITH a visible console notice), parses its JSONL
//  events, and maps divergences (order == token) into the trace so the canvas
//  can flash the diverging block.

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

import type { Graph } from '@iss/contracts/graph';
import { undeliveredHops, type Divergence, type Trace } from '@iss/contracts/trace';
import { isThin, parseTrace } from '../trace/parse';
import { synthesizeTrace } from '../trace/synthesize';
import { verilateLeaves, type SvLeafRef } from './verilate';
import { clearWaves } from './waves';

export interface RunDeps {
  projectRoot: string;
  enginePath: string;
  xverifyPath?: string;
  sailCommitrecPath?: string;
  refModel: 'sail' | 'stub';
  log: (line: string) => void;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  onLine?: (line: string) => void,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '';
    let buffer = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        onLine?.(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => onLine?.(chunk.toString().trimEnd()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim()) onLine?.(buffer.trimEnd());
      resolve({ code: code ?? 1, stdout });
    });
  });
}

export async function simulate(
  deps: RunDeps,
  graph: Graph,
  svLeaves: SvLeafRef[] = [],
): Promise<Trace> {
  const { projectRoot, enginePath, log } = deps;
  const buildDir = path.join(projectRoot, 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  const engineLib = path.join(enginePath, 'build', 'libmicroarch.a');
  if (!fs.existsSync(engineLib)) {
    log(`engine library missing — building it (${enginePath})…`);
    const made = await run('make', ['build/libmicroarch.a'], { cwd: enginePath });
    if (made.code !== 0) throw new Error('engine build failed — see console');
  }

  // Co-simulation: verilate the SV-impl twins; their model dirs + the
  // Verilator runtime join the design compile below.
  const verilated = await verilateLeaves(projectRoot, svLeaves, log);
  if (svLeaves.length > 0)
    log(
      `co-sim: ${svLeaves.length} block(s) execute their SystemVerilog twin ` +
        `(${svLeaves.map((l) => l.id).join(', ')}); the rest run C++.`,
    );

  // Generated blocks are single-file inline classes #include'd by the
  // harness — compile only the harness plus hand-written (non-marker) TUs.
  const srcDir = path.join(projectRoot, 'src');
  const sources = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.cpp'))
    .filter((f) => {
      if (f === 'iss_main_gen.cpp') return true;
      const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
      return !text.includes('=== ISS-AUTHORED:BEGIN');
    })
    .map((f) => path.join('src', f));
  const out = path.join('build', 'design');
  const args = [
    '-std=c++17',
    '-O2',
    '-Iinc',
    '-Isrc',
    `-I${path.join(enginePath, 'include')}`,
    // build/ holds the generated co-sim adapters header when SV blocks exist.
    ...(svLeaves.length > 0 ? ['-Ibuild', '-pthread'] : []),
    ...verilated.includeDirs.map((d) => `-I${d}`),
    ...sources,
    ...verilated.sources,
    engineLib,
    '-o',
    out,
  ];
  log(`g++ ${args.join(' ')}`);
  // Verilated models + runtime make the co-sim compile noticeably heavier.
  const compileTimeout = svLeaves.length > 0 ? 300_000 : 120_000;
  const compiled = await run('g++', args, { cwd: projectRoot, timeoutMs: compileTimeout }, log);
  if (compiled.code !== 0) throw new Error('compile failed — see console');

  // Fresh waves dir: the adapters' VCD open path is cwd-relative, and stale
  // dumps from a previous run must not survive into this one.
  clearWaves(projectRoot);

  // No CLI arg: the harness default is the configured cycle budget
  // (iss_run.json → emitHarness), which an explicit arg would override.
  log('./build/design');
  const ran = await run(out, [], { cwd: projectRoot }, log);
  if (ran.code !== 0) throw new Error(`design exited with code ${ran.code}`);
  // The binary reports the cycles it actually executed ("ran N cycles").
  const ranCycles = Number(/ran (\d+) cycles/.exec(ran.stdout)?.[1] ?? NaN);

  const traceFile = path.join(projectRoot, 'iss_trace.jsonl');
  const trace = fs.existsSync(traceFile)
    ? parseTrace(
        fs.readFileSync(traceFile, 'utf8'),
        graph,
        Number.isFinite(ranCycles) ? ranCycles : undefined,
      )
    : null;
  if (!trace || isThin(trace)) {
    log('trace is thin (no hops) — falling back to a synthetic preview');
    return synthesizeTrace(graph);
  }
  log(`real trace: ${trace.hops.length} hops over ${trace.cycles} cycles`);
  const undelivered = undeliveredHops(trace);
  if (undelivered.length > 0) {
    const worst = undelivered.reduce((m, h) => Math.max(m, h.arrive), 0);
    log(
      `⚠ ${undelivered.length} event(s) were still in flight when the clock stopped ` +
        `(engine ran ${trace.ranCycles} cycles; arrivals extend to cycle ${worst}). ` +
        `They were never delivered — raise cycles in the run config (⚙▾ next to Run) ` +
        `or shorten the wire latencies involved.`,
    );
  }
  return trace;
}

export interface VerifyResult {
  ok: boolean | null;
  matched: number;
  ref: 'sail' | 'stub';
  divergences: Divergence[];
}

export async function verify(
  deps: RunDeps,
  graph: Graph,
  trace: Trace | null,
  program?: string,
): Promise<VerifyResult> {
  const { xverifyPath, sailCommitrecPath, log } = deps;
  if (!xverifyPath || !fs.existsSync(xverifyPath)) {
    log('xverify not configured (iss2.xverifyPath) — cross-verification skipped');
    return { ok: null, matched: 0, ref: deps.refModel, divergences: [] };
  }

  let ref = deps.refModel;
  const env = { ...process.env };
  if (ref === 'sail') {
    if (sailCommitrecPath && fs.existsSync(sailCommitrecPath)) {
      env.XVERIFY_SAIL_COMMITREC = sailCommitrecPath;
    } else {
      log('Sail driver not found (iss2.sailCommitrecPath) — falling back to --ref stub');
      ref = 'stub';
    }
  }

  const xverifyDir = path.dirname(xverifyPath);
  let programPath = program;
  if (!programPath) {
    const candidate = path.join(xverifyDir, 'tests', 'programs', 'basic.hex');
    if (fs.existsSync(candidate)) programPath = candidate;
  }
  if (!programPath) {
    log('no program (.hex) available — cross-verification skipped');
    return { ok: null, matched: 0, ref, divergences: [] };
  }

  log(`xverify --json --ref ${ref} ${programPath}`);
  const divergences: Divergence[] = [];
  let ok: boolean | null = null;
  let matched = 0;

  const lastHopOf = (token: number) => {
    if (!trace) return null;
    let last = null as null | { to: string; arrive: number };
    for (const hop of trace.hops)
      if (hop.token === token && (!last || hop.arrive > last.arrive))
        last = { to: hop.to, arrive: hop.arrive };
    return last;
  };

  await run(
    xverifyPath,
    ['--json', '--ref', ref, programPath],
    { cwd: xverifyDir, env, timeoutMs: 30_000 },
    (line) => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        log(line);
        return;
      }
      if (obj.type === 'divergence') {
        const order = Number(obj.order ?? 0);
        const hop = lastHopOf(order);
        divergences.push({
          cycle: hop?.arrive ?? 0,
          component: hop?.to ?? graph.components[graph.components.length - 1]?.id ?? '',
          token: order,
          detail: String(obj.detail ?? 'divergence'),
          provenance: 'architectural',
        });
        log(`DIVERGENCE @ order ${order}: ${String(obj.detail ?? '')}`);
      } else if (obj.type === 'result') {
        ok = obj.ok === true;
        matched = Number(obj.matched ?? 0);
        log(ok ? `MATCHED ${matched} commits against ${ref}` : `FAILED after ${matched} commits`);
      } else {
        log(line);
      }
    },
  );
  return { ok, matched, ref, divergences };
}
