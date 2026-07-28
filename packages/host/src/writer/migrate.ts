// Sidecar migration ladder — PURE. No fs, no side effects, fully testable.
//
// These conversions used to live inline inside `loadModel`, which meant they
// could only be exercised by writing a file to disk and reading it back. They
// are the only thing standing between an old project and a silently wrong
// model, so they get their own module and their own tests.
//
// Adding a migration:
//   1. bump SCHEMA_VERSION in @iss/contracts/model
//   2. add a `migrateNtoN+1` below and append it to LADDER
//   3. add a fixture to ide/test/migrate.test.ts
//
// A migration must be TOTAL (never throw on a plausible old model) and should
// push a MigrationNote for anything it reinterprets rather than merely renames
// — a value whose MEANING changed is exactly what a user needs told.

import { DEFAULT_EVENT_BITS } from '@iss/contracts/bits';
import { SCHEMA_VERSION, type AuthoringModel } from '@iss/contracts/model';

/** Something a migration reinterpreted or invented, surfaced to the user. */
export interface MigrationNote {
  /** Dotted path into the model, e.g. "R2.portBandwidthBits". */
  field: string;
  value: unknown;
  reason: string;
}

export type MigrateOutcome =
  | { ok: true; model: AuthoringModel; from: number; notes: MigrationNote[] }
  | { ok: false; reason: 'corrupt'; detail: string }
  | { ok: false; reason: 'newer'; version: number };

/** The version of a parsed sidecar. Pre-versioned files are 0. */
export function versionOf(raw: unknown): number {
  const v = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isModelShape(raw: unknown): raw is AuthoringModel {
  if (typeof raw !== 'object' || raw === null) return false;
  const m = raw as { components?: unknown; events?: unknown };
  return Array.isArray(m.components) && Array.isArray(m.events);
}

/* ------------------------------------------------------------------ v0 → v1 */

/**
 * The pre-versioned era: hierarchy defaults, a single-router `fabric` string,
 * bandwidth counted in packets, and spec-driven `IO.*` leaves.
 */
function migrate0to1(model: AuthoringModel, notes: MigrationNote[]): void {
  for (const c of model.components) {
    // Older sidecars predate hierarchy/vars.
    c.kind = c.kind ?? 'leaf';
    c.parent = c.parent ?? (c.id.includes('.') ? c.id.slice(0, c.id.lastIndexOf('.')) : null);
    c.vars = c.vars ?? [];

    // A component may now attach to several routers, so `fabric` is a list.
    const fabric = (c as { fabric?: unknown }).fabric;
    if (typeof fabric === 'string') c.fabric = [fabric];

    // Bandwidth used to be packets per port per cycle. It is now BITS, so an
    // old number cannot simply be reinterpreted — 3 packets/cy is not 3 bits/cy.
    // Convert at the only rate the old model implied: it treated every packet
    // as costing the same, so one packet is one default-width word.
    const legacy = (c as { portBandwidth?: unknown }).portBandwidth;
    if (typeof legacy === 'number' && c.portBandwidthBits === undefined) {
      c.portBandwidthBits = legacy * DEFAULT_EVENT_BITS;
      delete (c as { portBandwidth?: unknown }).portBandwidth;
      notes.push({
        field: `${c.id}.portBandwidthBits`,
        value: c.portBandwidthBits,
        reason:
          `converted from ${legacy} packets/cycle at ${DEFAULT_EVENT_BITS} bits per ` +
          `packet — bandwidth is now metered in bits`,
      });
    }

    // Legacy spec-driven IO.* leaves become I/O pin blocks; `io` is
    // display-only, so behavior is unchanged.
    if (c.io === undefined && c.kind === 'leaf' && c.id.startsWith('IO.')) {
      const outs = c.outPorts?.length ?? 0;
      const ins = c.consumes?.length ?? 0;
      if (outs > 0 && ins === 0) c.io = 'in';
      else if (ins > 0 && outs === 0) c.io = 'out';
    }
  }
}

/** Index i migrates version i → i+1. */
const LADDER: Array<(model: AuthoringModel, notes: MigrationNote[]) => void> = [migrate0to1];

/* ---------------------------------------------------------------------- run */

/**
 * Bring a parsed sidecar up to SCHEMA_VERSION.
 *
 * Pure: the input is never mutated. Returns `newer` rather than guessing when
 * the file comes from a build ahead of this one — the caller must then refuse
 * to write, or it will destroy a model it cannot represent.
 */
export function migrate(raw: unknown): MigrateOutcome {
  if (!isModelShape(raw))
    return {
      ok: false,
      reason: 'corrupt',
      detail: 'expected an object with `components` and `events` arrays',
    };

  const from = versionOf(raw);
  if (from > SCHEMA_VERSION) return { ok: false, reason: 'newer', version: from };

  const model = JSON.parse(JSON.stringify(raw)) as AuthoringModel;
  const notes: MigrationNote[] = [];
  for (let v = from; v < SCHEMA_VERSION; v++) LADDER[v](model, notes);
  model.schemaVersion = SCHEMA_VERSION;

  return { ok: true, model, from, notes };
}
