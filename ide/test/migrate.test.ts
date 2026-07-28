// The sidecar migration ladder and the four load outcomes.
//
// This is the safety net for every later schema change, so it is fixture-driven
// against the REAL robot_soc and sample sidecars rather than hand-built objects
// — a migration that passes on a toy model and mangles the demos is exactly the
// failure this suite exists to catch.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SCHEMA_VERSION, type AuthoringModel } from '@iss/contracts/model';
import { migrate, versionOf } from '@iss/host/writer/migrate';
import { SIDECAR, backupSidecarFor, loadModel, openModel, writeModel } from '@iss/host/writer/index';

const REPO = path.resolve(__dirname, '..', '..');

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iss-migrate-'));
}

function seed(root: string, sidecar: unknown): void {
  fs.writeFileSync(path.join(root, SIDECAR), JSON.stringify(sidecar, null, 2));
}

/** A v0 sidecar exercising every conversion in the 0→1 rung at once. */
function legacySidecar(): Record<string, unknown> {
  return {
    components: [
      // string `fabric`, packet-counted bandwidth, no kind/parent/vars
      { id: 'R1', outPorts: [], consumes: [], fabric: 'R0', portBandwidth: 3 },
      { id: 'CPU0.IF', kind: 'leaf', outPorts: [], consumes: [], vars: [] },
      // legacy spec-driven IO leaves: direction inferred from shape
      { id: 'IO.In1', kind: 'leaf', outPorts: [{ name: 'out', message: 'M', to: null, latency: null }], consumes: [] },
      { id: 'IO.Out1', kind: 'leaf', outPorts: [], consumes: ['M'] },
    ],
    events: [{ id: 'M', fields: [] }],
  };
}

describe('versionOf', () => {
  it('treats a sidecar with no schemaVersion as version 0', () => {
    expect(versionOf({ components: [], events: [] })).toBe(0);
    expect(versionOf({ schemaVersion: 1, components: [], events: [] })).toBe(1);
    expect(versionOf(null)).toBe(0);
  });
});

describe('migrate', () => {
  it('rejects anything that is not model-shaped', () => {
    for (const bad of [null, 42, 'nope', {}, { components: [] }, { events: [] }]) {
      const out = migrate(bad);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('corrupt');
    }
  });

  it('refuses a sidecar from a newer build rather than guessing', () => {
    const out = migrate({ schemaVersion: SCHEMA_VERSION + 5, components: [], events: [] });
    expect(out.ok).toBe(false);
    if (!out.ok && out.reason === 'newer') expect(out.version).toBe(SCHEMA_VERSION + 5);
    else throw new Error('expected reason "newer"');
  });

  it('does not mutate its input', () => {
    const raw = legacySidecar();
    const before = JSON.stringify(raw);
    migrate(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('is idempotent — migrating an already-current model changes nothing', () => {
    const once = migrate(legacySidecar());
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = migrate(once.model);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.from).toBe(SCHEMA_VERSION);
    expect(twice.model).toEqual(once.model);
    expect(twice.notes).toEqual([]);
  });

  describe('v0 → v1', () => {
    const out = migrate(legacySidecar());
    if (!out.ok) throw new Error('fixture failed to migrate');
    const byId = (id: string) => out.model.components.find((c) => c.id === id)!;

    it('stamps the current version and reports where it came from', () => {
      expect(out.from).toBe(0);
      expect(out.model.schemaVersion).toBe(SCHEMA_VERSION);
    });

    it('defaults kind, parent and vars', () => {
      expect(byId('R1').kind).toBe('leaf');
      expect(byId('R1').parent).toBeNull();
      expect(byId('R1').vars).toEqual([]);
      expect(byId('CPU0.IF').parent).toBe('CPU0');
    });

    it('widens a single-router fabric string to a list', () => {
      expect(byId('R1').fabric).toEqual(['R0']);
    });

    it('converts packets/cycle to bits/cycle and says so', () => {
      // 3 packets/cy at the default 32-bit packet = 96 bits/cy. Reinterpreting
      // 3 as three BITS would silently throttle every existing design.
      expect(byId('R1').portBandwidthBits).toBe(96);
      expect((byId('R1') as { portBandwidth?: unknown }).portBandwidth).toBeUndefined();
      const note = out.notes.find((n) => n.field === 'R1.portBandwidthBits');
      expect(note?.value).toBe(96);
      expect(note?.reason).toMatch(/packets\/cycle/);
    });

    it('infers io direction for legacy IO.* leaves from their shape', () => {
      expect(byId('IO.In1').io).toBe('in');
      expect(byId('IO.Out1').io).toBe('out');
      expect(byId('CPU0.IF').io).toBeUndefined();
    });
  });
});

describe('the real demo sidecars', () => {
  for (const demo of ['robot_soc', 'sample']) {
    it(`${demo} migrates without loss`, () => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(REPO, demo, SIDECAR), 'utf8'),
      ) as AuthoringModel;
      const out = migrate(raw);
      expect(out.ok).toBe(true);
      if (!out.ok) return;

      // Every component and event survives, ids intact.
      expect(out.model.components.map((c) => c.id)).toEqual(raw.components.map((c) => c.id));
      expect(out.model.events.map((e) => e.id)).toEqual(raw.events.map((e) => e.id));
      expect(out.model.schemaVersion).toBe(SCHEMA_VERSION);
    });
  }

  it('preserves robot_soc R2 bandwidth exactly (already in bits, not converted)', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'robot_soc', SIDECAR), 'utf8'));
    const out = migrate(raw);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r2 = out.model.components.find((c) => c.id === 'R2');
    expect(r2?.portBandwidthBits).toBe(96);
    expect(out.notes).toEqual([]); // nothing was reinterpreted
  });
});

describe('loadModel — the four outcomes', () => {
  it('absent: a project with no sidecar', () => {
    const result = loadModel(tmp());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('absent');
  });

  it('corrupt: unparseable JSON', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, SIDECAR), '{ not json');
    const result = loadModel(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('corrupt');
  });

  it('newer: written by a build ahead of this one', () => {
    const root = tmp();
    seed(root, { schemaVersion: SCHEMA_VERSION + 1, components: [], events: [] });
    const result = loadModel(root);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'newer') expect(result.version).toBe(SCHEMA_VERSION + 1);
    else throw new Error('expected reason "newer"');
  });

  it('ok: a current sidecar loads with no migration and no backup', () => {
    const root = tmp();
    seed(root, { schemaVersion: SCHEMA_VERSION, components: [], events: [] });
    const result = loadModel(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBeUndefined();
    expect(fs.existsSync(path.join(root, backupSidecarFor(0)))).toBe(false);
  });
});

describe('migration backup', () => {
  it('parks the original before returning a migrated model', () => {
    const root = tmp();
    const original = legacySidecar();
    seed(root, original);

    const result = loadModel(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(0);

    const backup = path.join(root, backupSidecarFor(0));
    expect(fs.existsSync(backup)).toBe(true);
    expect(JSON.parse(fs.readFileSync(backup, 'utf8'))).toEqual(original);
  });

  it('never clobbers an existing backup — the first one is the true original', () => {
    const root = tmp();
    seed(root, legacySidecar());
    loadModel(root);

    const backup = path.join(root, backupSidecarFor(0));
    const first = fs.readFileSync(backup, 'utf8');

    // A second load (say the user reopened the project) must not overwrite it.
    seed(root, { components: [{ id: 'Different', outPorts: [], consumes: [] }], events: [] });
    loadModel(root);
    expect(fs.readFileSync(backup, 'utf8')).toBe(first);
  });
});

describe('openModel — what the hosts actually call', () => {
  it('an absent sidecar is a new project, not a failure', () => {
    const opened = openModel(tmp());
    expect(opened.blocked).toBeNull();
    expect(opened.model.components).toEqual([]);
  });

  it('blocks editing when the sidecar is newer', () => {
    const root = tmp();
    seed(root, { schemaVersion: SCHEMA_VERSION + 1, components: [], events: [] });
    const opened = openModel(root);
    expect(opened.blocked).toMatch(/newer version/);
  });

  it('blocks editing when the sidecar is corrupt', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, SIDECAR), 'nope');
    const opened = openModel(root);
    expect(opened.blocked).toMatch(/could not be read/);
  });

  // The regression this whole stage exists to prevent: an unreadable sidecar
  // used to be indistinguishable from no sidecar, so the next write destroyed it.
  it('an unreadable sidecar is never silently replaced by an empty design', () => {
    const root = tmp();
    const file = path.join(root, SIDECAR);
    fs.writeFileSync(file, '{ truncated...');
    const before = fs.readFileSync(file, 'utf8');

    const opened = openModel(root);
    expect(opened.blocked).not.toBeNull();
    // The host refuses to write; the bytes on disk are untouched.
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('writeModel stamps the version', () => {
  it('a written sidecar is never mistaken for a pre-versioned one', () => {
    const root = tmp();
    writeModel(root, { components: [], events: [] } as AuthoringModel, null);
    const written = JSON.parse(fs.readFileSync(path.join(root, SIDECAR), 'utf8'));
    expect(written.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loadModel(root).ok).toBe(true);
  });
});
