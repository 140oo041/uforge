// SV twins: emission (ports from the event interface, spec-aware widths),
// hand-edit survival below the marker region, orphan retirement, the setImpl
// reducer, and the roundtrip guard (twins are invisible to the parser).

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EMPTY_MODEL, type EditIntent } from '@iss/contracts/model';
import type { SpecDocument } from '@iss/contracts/spec';
import { applyIntent } from '@iss/host/writer/edits';
import { loadModel, writeModel } from '@iss/host/writer/index';
import { emitSvTwinBody, svType } from '@iss/host/writer/svtwin';
import { parseProject } from '@iss/host/parser/index';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-sv-'));

const SPEC: SpecDocument = {
  name: 'T',
  kind: 'accelerator',
  types: [{ name: 'word', base: 'uint32_t' }],
  signals: [{ name: 'Phase', underlying: 'uint8_t', values: ['IDLE', 'LOAD', 'RUN'] }],
  io: [],
  state: [],
  operations: [],
};

function model() {
  const intents: EditIntent[] = [
    { kind: 'addComponent', id: 'Sys', nodeKind: 'composite' },
    { kind: 'addComponent', id: 'Sys.IF' },
    { kind: 'addComponent', id: 'Sys.DE' },
    { kind: 'addComponent', id: 'Sys.MEM' },
    {
      kind: 'addEvent',
      id: 'FetchEvent',
      fields: [
        { name: 'pc', type: 'word' },
        { name: 'instruction', type: 'uint32_t' },
        { name: 'valid', type: 'bool' },
        { name: 'phase', type: 'Phase' },
      ],
    },
    { kind: 'addEvent', id: 'StallEvent', fields: [] },
    { kind: 'addWire', from: 'Sys.IF', port: 'out_IF_to_DE', message: 'FetchEvent', to: 'Sys.DE', latency: 1 },
    { kind: 'addWire', from: 'Sys.IF', port: 'out_IF_to_MEM', message: 'StallEvent', to: 'Sys.MEM', latency: 1 },
    { kind: 'setConsumes', id: 'Sys.IF', consumes: ['StallEvent'] },
  ];
  return intents.reduce(applyIntent, EMPTY_MODEL);
}

describe('svType', () => {
  it('maps C++/spec types to SV nets', () => {
    expect(svType('uint32_t')).toBe('logic [31:0]');
    expect(svType('uint8_t')).toBe('logic [7:0]');
    expect(svType('bool')).toBe('logic');
    expect(svType('word', SPEC)).toBe('logic [31:0]'); // alias resolved
    expect(svType('Phase', SPEC)).toBe('logic [1:0] /* Phase */'); // 3 values → 2 bits
    expect(svType('WeirdT')).toContain('TODO width');
  });
});

describe('SV twin emission', () => {
  it('module ports mirror the event interface (valid strobes + fields)', () => {
    const m = model();
    const comp = m.components.find((c) => c.id === 'Sys.IF')!;
    const body = emitSvTwinBody(comp, m, SPEC);
    expect(body).toContain('module IF (');
    expect(body).toContain('input  logic clk,');
    expect(body).toContain('input  logic StallEvent_valid,');
    expect(body).toContain('output logic out_IF_to_DE_valid,');
    expect(body).toContain('output logic [31:0] out_IF_to_DE_pc,');
    expect(body).toContain('output logic [31:0] out_IF_to_DE_instruction,');
    expect(body).toContain('output logic out_IF_to_DE_valid,');
    expect(body).toContain('output logic [1:0] /* Phase */ out_IF_to_DE_phase,');
    // Final port has no trailing comma; header closes after the lint waiver.
    expect(body).toContain('output logic out_IF_to_MEM_valid\n');
    expect(body).toMatch(/out_IF_to_MEM_valid\n\s*\/\* verilator lint_on UNUSEDSIGNAL \*\/\n\);/);
  });

  it('twins are written next to the .cpp, and hand edits below the markers survive', () => {
    const root = tmp();
    const m = model();
    writeModel(root, m, SPEC);
    const svPath = path.join(root, 'src', 'Sys', 'IF.sv');
    expect(fs.existsSync(svPath)).toBe(true);
    const fresh = fs.readFileSync(svPath, 'utf8');
    expect(fresh).toContain('endmodule');

    // Hand-write behavior below the generated region…
    const edited = fresh.replace(
      '// TODO: behavioral twin of the C++ block.',
      'logic [31:0] pc_q; // my hand-written state',
    );
    fs.writeFileSync(svPath, edited);
    // …then regenerate with a changed interface: ports update, hand code stays.
    const m2 = applyIntent(m, {
      kind: 'addWire',
      from: 'Sys.IF',
      port: 'out_IF_to_MEM2',
      message: 'StallEvent',
      to: 'Sys.MEM',
      latency: 1,
    });
    writeModel(root, m2, SPEC);
    const regen = fs.readFileSync(svPath, 'utf8');
    expect(regen).toContain('out_IF_to_MEM2_valid');
    expect(regen).toContain('my hand-written state');
  });

  it('orphan twins are retired with their block (hand-written .sv untouched)', () => {
    const root = tmp();
    const m = model();
    writeModel(root, m, SPEC);
    const handSv = path.join(root, 'src', 'HandRolled.sv');
    fs.writeFileSync(handSv, 'module HandRolled(); endmodule\n');

    const m2 = applyIntent(m, { kind: 'removeComponent', id: 'Sys.MEM' });
    writeModel(root, m2, SPEC);
    expect(fs.existsSync(path.join(root, 'src', 'MEM.sv'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src', 'MEM.cpp'))).toBe(false);
    expect(fs.existsSync(handSv)).toBe(true); // no marker → never deleted
  });

  it('setImpl persists through the sidecar and twins stay invisible to the parser', () => {
    const root = tmp();
    const m = applyIntent(model(), { kind: 'setImpl', id: 'Sys.IF', impl: 'sv' });
    writeModel(root, m, SPEC);
    expect(loadModel(root)!.components.find((c) => c.id === 'Sys.IF')?.impl).toBe('sv');
    // Back to cpp drops the field entirely (default).
    const m2 = applyIntent(m, { kind: 'setImpl', id: 'Sys.IF', impl: 'cpp' });
    expect(m2.components.find((c) => c.id === 'Sys.IF')?.impl).toBeUndefined();

    // Roundtrip guard: with .sv twins on disk the graph is unchanged.
    const graph = parseProject([root]);
    expect(graph.components.map((c) => c.id).sort()).toEqual(['Sys', 'Sys.DE', 'Sys.IF', 'Sys.MEM']);
    expect(graph.links).toHaveLength(2);
    expect(graph.links.every((l) => l.status === 'wired')).toBe(true);
  });
});
