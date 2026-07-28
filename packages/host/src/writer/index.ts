// The only fs-touching writer module: renders the AuthoringModel to
// single-file blocks (src/<path>/<Leaf>.cpp) + the shared events header +
// the JSON sidecar, splice-aware so hand edits outside marker regions
// survive. Deterministic: a no-op re-write is byte-identical.

import * as fs from 'fs';
import * as path from 'path';

import { EMPTY_MODEL, SCHEMA_VERSION, leafName, type AuthoringModel } from '@iss/contracts/model';
import type { RunConfig } from '@iss/contracts/runConfig';
import type { SpecDocument } from '@iss/contracts/spec';
import {
  ARCH_PROLOGUE,
  BLOCK_PROLOGUE,
  EVENTS_PROLOGUE,
  emitArchHeaderBody,
  emitBlockBody,
  emitEventsHeaderBody,
} from './blockfile';
import { BEGIN_MARKER, END_MARKER, spliceRegion } from './markers';
import { migrate, type MigrationNote } from './migrate';
import { HARNESS_FILE, emitHarness } from './harness';
import { ROUTER_PROLOGUE, emitRouterBody, routerFileFor, routerTailFor } from './routerfile';
import {
  TRAFFIC_PROLOGUE,
  emitTrafficGenBody,
  emitTrafficGenHead,
  trafficTailFor,
} from './trafficfile';
import { SV_ADAPTERS_FILE, emitSvAdapters, svLeavesOf } from './svadapter';
import { SV_PROLOGUE, emitSvTwinBody, svFileFor, svTailFor } from './svtwin';

export const SIDECAR = 'iss_authored.model.json';

/** src-relative file for a leaf block: dot-path → directories. */
export function blockFileFor(id: string): string {
  return path.join(...id.split('.')) + '.cpp';
}

function writeSpliced(file: string, prologue: string, body: string): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : prologue;
  const next = spliceRegion(existing, body);
  if (next !== existing || !fs.existsSync(file)) fs.writeFileSync(file, next);
}

function walkExt(dir: string, ext: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkExt(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Hand-owned content below the END marker (trimmed), or '' when none. */
function tailOf(text: string): string {
  const end = text.indexOf(END_MARKER);
  return end < 0 ? '' : text.slice(end + END_MARKER.length).trim();
}

function pruneEmptyDirs(dir: string, stopAt: string): void {
  if (dir === stopAt) return;
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      pruneEmptyDirs(path.dirname(dir), stopAt);
    }
  } catch {
    // gone or unreadable — nothing to prune
  }
}

export function writeModel(
  projectRoot: string,
  model: AuthoringModel,
  spec: SpecDocument | null = null,
): string[] {
  const inc = path.join(projectRoot, 'inc');
  const src = path.join(projectRoot, 'src');
  fs.mkdirSync(inc, { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  const written: string[] = [];

  // The arch header always exists (iss_events.h includes it) — empty spec
  // renders an empty ArchState.
  const archHeader = path.join(inc, 'iss_arch.h');
  writeSpliced(archHeader, ARCH_PROLOGUE, emitArchHeaderBody(spec));
  written.push(archHeader);

  const eventsHeader = path.join(inc, 'iss_events.h');
  writeSpliced(eventsHeader, EVENTS_PROLOGUE, emitEventsHeaderBody(model.events, spec));
  written.push(eventsHeader);

  const leaves = model.components.filter((c) => c.kind === 'leaf');
  for (const comp of leaves) {
    const file = path.join(src, blockFileFor(comp.id));
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // Traffic generators: their own codegen + ownership modes; no SV twin.
    if (comp.role === 'trafficgen') {
      const mode = comp.trafficMode ?? 'generated';
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (mode === 'generated') {
        // A generated-mode gen file is fully canvas-owned (prologue included)
        // — write the exact desired content. This also migrates files with a
        // stale prologue and completes the re-attach transition (a leftover
        // hand-owned tail would duplicate tick(); the inspector confirmed
        // the destructive step before the mode intent fired).
        const desired = `${TRAFFIC_PROLOGUE}${BEGIN_MARKER}\n${emitTrafficGenBody(comp, model, spec)}\n${END_MARKER}\n`;
        if (existing !== desired) fs.writeFileSync(file, desired);
      } else {
        const head = emitTrafficGenHead(comp, model, spec);
        if (existing === null || tailOf(existing) === '') {
          // Fresh file or detach transition: seed the tail with the current
          // generated tick() so behavior starts unchanged.
          fs.writeFileSync(
            file,
            `${TRAFFIC_PROLOGUE}${BEGIN_MARKER}\n${head}\n${END_MARKER}\n${trafficTailFor(comp, model, spec)}`,
          );
        } else {
          const next = spliceRegion(existing, head);
          if (next !== existing) fs.writeFileSync(file, next);
        }
      }
      written.push(file);
      continue;
    }

    // Migration: a legacy two-file block (`#include "<Leaf>.h"`) was fully
    // generated — rewrite it whole so the retired header include goes away.
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8');
      if (
        existing.includes(BEGIN_MARKER) &&
        existing.includes(`#include "${leafName(comp.id)}.h"`)
      )
        fs.unlinkSync(file);
    }
    writeSpliced(file, BLOCK_PROLOGUE, emitBlockBody(comp, model, spec));
    written.push(file);

    // The SV twin: generated region = module header + ports; the behavioral
    // body below the markers (incl. endmodule) is hand-owned and survives.
    const svFile = path.join(src, svFileFor(comp.id));
    const svBody = emitSvTwinBody(comp, model, spec);
    if (!fs.existsSync(svFile)) {
      fs.writeFileSync(
        svFile,
        `${SV_PROLOGUE}${BEGIN_MARKER}\n${svBody}\n${END_MARKER}\n${svTailFor(comp, model)}`,
      );
    } else {
      const existing = fs.readFileSync(svFile, 'utf8');
      const next = spliceRegion(existing, svBody);
      if (next !== existing) fs.writeFileSync(svFile, next);
    }
    written.push(svFile);
  }

  // Routers are real components with real source: one src/<R>.cpp each. The
  // generated region opens the class (ctor + flat default); the hand tail
  // below the markers holds user latency models and the closing brace.
  const routers = model.components.filter((c) => c.kind === 'router');
  for (const comp of routers) {
    const file = path.join(src, routerFileFor(comp.id));
    const body = emitRouterBody(comp, model);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        `${ROUTER_PROLOGUE}${BEGIN_MARKER}\n${body}\n${END_MARKER}\n${routerTailFor(comp)}`,
      );
    } else {
      const existing = fs.readFileSync(file, 'utf8');
      const next = spliceRegion(existing, body);
      if (next !== existing) fs.writeFileSync(file, next);
    }
    written.push(file);
  }

  // Retire generated files for blocks no longer in the model — only files
  // that carry the marker (never a hand-written file). Same sweep for the
  // .sv twins (routers have no twins — their .cpp is in the live set).
  const live = new Set([...leaves, ...routers].map((c) => c.id));
  for (const ext of ['.cpp', '.sv']) {
    for (const file of walkExt(src, ext)) {
      const id = path
        .relative(src, file)
        .slice(0, -ext.length)
        .split(path.sep)
        .join('.');
      if (live.has(id) || id === 'iss_main_gen' || id === 'iss_events') continue;
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(BEGIN_MARKER)) {
        fs.unlinkSync(file);
        pruneEmptyDirs(path.dirname(file), src);
      }
    }
  }
  // Retire legacy generated headers (the old two-file layout).
  for (const name of fs.readdirSync(inc)) {
    if (!name.endsWith('.h') || name === 'iss_events.h' || name === 'iss_arch.h') continue;
    const file = path.join(inc, name);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(BEGIN_MARKER)) fs.unlinkSync(file);
  }

  // Always stamp the version, so a file written by this build is never
  // mistaken for a pre-versioned one on the next load.
  const sidecar = path.join(projectRoot, SIDECAR);
  const stamped: AuthoringModel = { ...model, schemaVersion: SCHEMA_VERSION };
  fs.writeFileSync(sidecar, JSON.stringify(stamped, null, 2) + '\n');
  written.push(sidecar);
  return written;
}

export interface OpenedModel {
  model: AuthoringModel;
  /** Non-null when the sidecar could not be used. Edits MUST be refused and
   *  this message shown — writing would destroy a design we cannot represent. */
  blocked: string | null;
  /** Non-empty when loading migrated the file forward. */
  notes: MigrationNote[];
  migratedFrom?: number;
}

/**
 * Open a project's model for editing, resolving all four load outcomes into the
 * shape a host actually needs. Both hosts call THIS rather than `loadModel`
 * directly, so a blocked project behaves identically in the extension and the
 * desktop app instead of drifting.
 */
export function openModel(projectRoot: string): OpenedModel {
  const result = loadModel(projectRoot);
  if (result.ok)
    return {
      model: result.model,
      blocked: null,
      notes: result.notes ?? [],
      migratedFrom: result.migratedFrom,
    };

  switch (result.reason) {
    case 'absent':
      // A new project. Normal, and the only case that may safely be written.
      return { model: EMPTY_MODEL, blocked: null, notes: [] };
    case 'newer':
      return {
        model: EMPTY_MODEL,
        blocked:
          `${SIDECAR} was written by a newer version of ISS (schema v${result.version}; ` +
          `this build reads v${SCHEMA_VERSION}). Editing is disabled so your design is ` +
          `not overwritten — update ISS to open this project.`,
        notes: [],
      };
    case 'corrupt':
      return {
        model: EMPTY_MODEL,
        blocked:
          `${SIDECAR} could not be read (${result.detail}). Editing is disabled so it is ` +
          `not overwritten. Repair or remove the file to continue.`,
        notes: [],
      };
  }
}

/** Effective divergence-checked set: the run-config master switch covers all
 *  SV leaves; a block's own flag opts it in even when the switch is off. */
export function checkedLeaves(model: AuthoringModel, run?: RunConfig): Set<string> {
  return new Set(
    svLeavesOf(model)
      .filter((c) => run?.checkDivergence === true || c.checkDivergence === true)
      .map((c) => c.id),
  );
}

export function writeHarness(
  projectRoot: string,
  model: AuthoringModel,
  run?: RunConfig,
): string {
  const src = path.join(projectRoot, 'src');
  fs.mkdirSync(src, { recursive: true });
  const file = path.join(src, HARNESS_FILE);
  const checked = checkedLeaves(model, run);
  fs.writeFileSync(
    file,
    emitHarness(
      model,
      run
        ? { tokens: run.tokens, cycles: run.cycles, entries: run.entries, checked }
        : { checked },
    ),
  );
  // Co-sim adapters live in build/ (a derived artifact over the verilated
  // models; the parser skips build/, so adapters never parse as blocks).
  const adapters = path.join(projectRoot, 'build', SV_ADAPTERS_FILE);
  if (svLeavesOf(model).length > 0) {
    fs.mkdirSync(path.dirname(adapters), { recursive: true });
    fs.writeFileSync(
      adapters,
      emitSvAdapters(model, { waves: run?.wavesEnabled !== false, checked }),
    );
  } else if (fs.existsSync(adapters)) {
    fs.unlinkSync(adapters);
  }
  return file;
}

/** Where the pre-migration copy of a sidecar is parked. */
export function backupSidecarFor(version: number): string {
  return `iss_authored.model.v${version}.json.bak`;
}

export type LoadResult =
  | { ok: true; model: AuthoringModel; migratedFrom?: number; notes?: MigrationNote[] }
  | { ok: false; reason: 'absent' }
  | { ok: false; reason: 'newer'; version: number }
  | { ok: false; reason: 'corrupt'; detail: string };

/**
 * Read the sidecar, migrating it forward if it predates this build.
 *
 * The four outcomes are deliberately distinct. This function used to return
 * `null` for BOTH "no sidecar" and "sidecar I cannot parse", and both callers
 * collapsed that to `EMPTY_MODEL` — so a file this build could not read looked
 * exactly like a fresh project and was destroyed by the next `writeModel`.
 * A caller that receives `newer` or `corrupt` MUST NOT write.
 *
 * Migrating writes a one-time `.bak` of the original before returning, so the
 * pre-migration file survives even if the migration itself is wrong.
 */
export function loadModel(projectRoot: string): LoadResult {
  const file = path.join(projectRoot, SIDECAR);
  if (!fs.existsSync(file)) return { ok: false, reason: 'absent' };

  let text: string;
  let raw: unknown;
  try {
    text = fs.readFileSync(file, 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: 'corrupt', detail: (err as Error).message };
  }

  const outcome = migrate(raw);
  if (!outcome.ok) return outcome;

  if (outcome.from < SCHEMA_VERSION) {
    // Keep the original exactly as it was found — write once, never clobber an
    // existing backup (a second load must not overwrite the true original).
    const backup = path.join(projectRoot, backupSidecarFor(outcome.from));
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
    return { ok: true, model: outcome.model, migratedFrom: outcome.from, notes: outcome.notes };
  }
  return { ok: true, model: outcome.model };
}
