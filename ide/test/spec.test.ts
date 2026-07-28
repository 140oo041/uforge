// SPEC system: templates, the edit reducer, persistence, and migration from
// the legacy iss_isa.json overlay.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SPEC_TEMPLATES,
  TEMPLATE_ACCEL,
  TEMPLATE_GPU,
  TEMPLATE_RV32I,
  applySpecEdit,
  availableTypes,
  isSpecDocument,
  stateType,
  type SpecDocument,
} from '@iss/contracts/spec';
import { loadSpec, migrateLegacyOverlay, saveSpec } from '@iss/host/spec/index';
import { defaultFor, emitArchHeaderBody } from '@iss/host/writer/blockfile';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-spec-'));
}

describe('spec templates', () => {
  it('RV32I template is oracle-backed; GPU template is spec-only', () => {
    expect(TEMPLATE_RV32I.operations.every((o) => o.oracle)).toBe(true);
    expect(TEMPLATE_RV32I.operations.map((o) => o.mnemonic)).toContain('beq');
    expect(TEMPLATE_GPU.operations.every((o) => !o.oracle)).toBe(true);
    expect(TEMPLATE_GPU.kind).toBe('gpu');
    expect(TEMPLATE_GPU.lanes?.harts).toBeGreaterThan(1);
    for (const t of SPEC_TEMPLATES) expect(isSpecDocument(t.spec)).toBe(true);
  });

  it('templates carry universal-spec fields: types, signals', () => {
    expect(TEMPLATE_RV32I.types).toEqual([{ name: 'word', base: 'uint32_t' }]);
    expect(TEMPLATE_RV32I.state.find((s) => s.name === 'pc')?.init).toBe('0x80000000');
    expect(TEMPLATE_GPU.signals?.[0].name).toBe('WaveState');
    expect(TEMPLATE_ACCEL.kind).toBe('accelerator');
    // I/O is authored on the canvas now (pin blocks), not in the spec.
    expect(TEMPLATE_ACCEL.io).toEqual([]);
  });
});

describe('applySpecEdit', () => {
  it('meta, state, and operation edits are pure and idempotent by key', () => {
    let spec = structuredClone(TEMPLATE_RV32I);
    spec = applySpecEdit(spec, { kind: 'setMeta', name: 'Quad-core SoC', harts: 4 });
    expect(spec.name).toBe('Quad-core SoC');
    expect(spec.lanes?.harts).toBe(4);

    spec = applySpecEdit(spec, {
      kind: 'addState',
      element: { name: 'acc', label: 'Accumulator', bits: 64, space: 'reg' },
    });
    expect(spec.state.some((s) => s.name === 'acc')).toBe(true);

    spec = applySpecEdit(spec, {
      kind: 'addOp',
      op: { mnemonic: 'mac', format: 'R', summary: 'rd += rs1*rs2', oracle: false },
    });
    // Re-adding replaces, not duplicates.
    spec = applySpecEdit(spec, {
      kind: 'addOp',
      op: { mnemonic: 'mac', format: 'R', summary: 'rd += rs1*rs2 (v2)', oracle: false },
    });
    expect(spec.operations.filter((o) => o.mnemonic === 'mac')).toHaveLength(1);
    expect(spec.operations.find((o) => o.mnemonic === 'mac')!.summary).toContain('v2');

    spec = applySpecEdit(spec, { kind: 'removeOp', mnemonic: 'mac' });
    expect(spec.operations.some((o) => o.mnemonic === 'mac')).toBe(false);
    spec = applySpecEdit(spec, { kind: 'removeState', name: 'acc' });
    expect(spec.state.some((s) => s.name === 'acc')).toBe(false);
  });

  it('type / signal / io / editState edits are pure and keyed', () => {
    let spec = structuredClone(TEMPLATE_RV32I);
    spec = applySpecEdit(spec, { kind: 'addType', type: { name: 'half', base: 'uint16_t' } });
    expect(spec.types).toContainEqual({ name: 'half', base: 'uint16_t' });

    spec = applySpecEdit(spec, {
      kind: 'addSignal',
      signal: { name: 'OpKind', underlying: 'uint8_t', values: ['ADD'] },
    });
    spec = applySpecEdit(spec, {
      kind: 'editSignal',
      name: 'OpKind',
      signal: { values: ['ADD', 'SUB'] },
    });
    expect(spec.signals?.find((s) => s.name === 'OpKind')?.values).toEqual(['ADD', 'SUB']);

    spec = applySpecEdit(spec, {
      kind: 'addIo',
      port: { name: 'irq', direction: 'in', message: 'IrqEvent' },
    });
    expect(spec.io).toContainEqual({ name: 'irq', direction: 'in', message: 'IrqEvent' });

    spec = applySpecEdit(spec, {
      kind: 'editState',
      name: 'pc',
      element: { init: '0x0', type: 'half' },
    });
    const pc = spec.state.find((s) => s.name === 'pc')!;
    expect(pc.init).toBe('0x0');
    expect(stateType(pc)).toBe('half');

    spec = applySpecEdit(spec, { kind: 'removeIo', name: 'irq' });
    spec = applySpecEdit(spec, { kind: 'removeSignal', name: 'OpKind' });
    spec = applySpecEdit(spec, { kind: 'removeType', name: 'half' });
    expect(spec.io).toHaveLength(0);
    expect(spec.signals).toHaveLength(0);
    expect(spec.types?.some((t) => t.name === 'half')).toBe(false);
  });

  it('availableTypes = spec aliases + signals + builtins; stateType derives from bits', () => {
    const types = availableTypes(TEMPLATE_GPU);
    expect(types).toContain('lane_mask');
    expect(types).toContain('WaveState');
    expect(types).toContain('uint64_t');
    expect(stateType({ name: 'f', label: 'f', bits: 1 })).toBe('uint8_t');
    expect(stateType({ name: 'f', label: 'f', bits: 33 })).toBe('uint64_t');
  });
});

describe('arch header emission', () => {
  it('renders types, signal enums, and ArchState with inits', () => {
    const spec: SpecDocument = {
      name: 'T',
      kind: 'accelerator',
      types: [{ name: 'word', base: 'uint32_t' }],
      signals: [{ name: 'Phase', underlying: 'uint8_t', values: ['IDLE', 'RUN'] }],
      io: [],
      state: [
        { name: 'pc', label: 'Program counter', bits: 32, type: 'word', init: '0x80000000' },
        { name: 'x', label: 'Registers', bits: 32, count: 32 },
        { name: 'phase', label: 'Phase', bits: 8, type: 'Phase' },
      ],
      operations: [],
    };
    const body = emitArchHeaderBody(spec);
    expect(body).toContain('using word = uint32_t;');
    expect(body).toContain('enum class Phase : uint8_t {');
    expect(body).toContain('    IDLE,');
    expect(body).toContain('word pc = 0x80000000;');
    expect(body).toContain('uint32_t x[32] = {};');
    // Signal-typed state defaults to its first enumerator.
    expect(body).toContain('Phase phase = Phase::IDLE;');
    expect(body).toContain('inline ArchState arch;');
  });

  it('empty spec still yields a valid (empty) ArchState', () => {
    const body = emitArchHeaderBody(null);
    expect(body).toContain('struct ArchState {');
    expect(body).toContain('inline ArchState arch;');
  });

  it('defaultFor resolves aliases and signal enums through the spec', () => {
    const spec = structuredClone(TEMPLATE_GPU);
    expect(defaultFor('lane_mask', spec)).toBe(' = 0');
    expect(defaultFor('WaveState', spec)).toBe(' = WaveState::READY');
    expect(defaultFor('uint32_t')).toBe(' = 0');
    expect(defaultFor('SomeHandRolledStruct')).toBe('');
  });
});

describe('persistence + migration', () => {
  it('save/load round-trips', () => {
    const root = tmp();
    const spec = applySpecEdit(structuredClone(TEMPLATE_GPU), {
      kind: 'setMeta',
      name: 'Tile GPU',
    });
    saveSpec(root, spec);
    expect(loadSpec(root)).toEqual(spec);
  });

  it('returns null with neither spec nor legacy overlay', () => {
    expect(loadSpec(tmp())).toBeNull();
  });

  it('loads a v1 spec file (no types/signals/io) with defaulted arrays and free-form kind', () => {
    const root = tmp();
    fs.writeFileSync(
      path.join(root, 'iss_spec.json'),
      JSON.stringify({
        name: 'Old spec',
        kind: 'systolic-array', // v2: kind is free-form
        state: [{ name: 'acc', label: 'acc', bits: 64 }],
        operations: [],
      }),
    );
    const spec = loadSpec(root)!;
    expect(spec).not.toBeNull();
    expect(spec.kind).toBe('systolic-array');
    expect(spec.types).toEqual([]);
    expect(spec.signals).toEqual([]);
    expect(spec.io).toEqual([]);
  });

  it('migrates a legacy iss_isa.json overlay onto the RV32I base', () => {
    const root = tmp();
    fs.writeFileSync(
      path.join(root, 'iss_isa.json'),
      JSON.stringify({
        instructions: [{ mnemonic: 'mac', type: 'R', summary: 'rd += rs1*rs2' }],
        state: [{ name: 'acc', label: 'acc', bits: 64 }],
      }),
    );
    const spec = loadSpec(root)!;
    expect(spec).not.toBeNull();
    // Base survives; custom entries fold in as spec-only.
    expect(spec.operations.some((o) => o.mnemonic === 'add' && o.oracle)).toBe(true);
    const mac = spec.operations.find((o) => o.mnemonic === 'mac')!;
    expect(mac.oracle).toBe(false);
    expect(spec.state.some((s) => s.name === 'acc' && s.bits === 64)).toBe(true);
    // Migration persisted iss_spec.json.
    expect(fs.existsSync(path.join(root, 'iss_spec.json'))).toBe(true);
  });

  it('migrateLegacyOverlay overrides base entries by key', () => {
    const spec = migrateLegacyOverlay({
      instructions: [{ mnemonic: 'add', type: 'R', summary: 'patched' }],
    });
    const adds = spec.operations.filter((o) => o.mnemonic === 'add');
    expect(adds).toHaveLength(1);
    expect(adds[0].summary).toBe('patched');
  });
});
