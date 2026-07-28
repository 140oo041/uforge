// Generates the sample design project (../../sample) using the real writer —
// so the sample is, by construction, exactly what the canvas would produce.
// Demonstrates hierarchy (a CPU0 composite with the 5-stage pipeline inside,
// wired to a top-level Memory1) and component state variables.
// Run: npx tsx scripts/gen-sample.ts

import * as path from 'path';

import { EMPTY_MODEL, type EditIntent } from '../src/shared/model';
import { applyIntent } from '../src/writer/edits';
import { writeHarness, writeModel } from '../src/writer';
import { loadSpec, saveSpec, specPath } from '../src/spec';
import { TEMPLATE_RV32I, applySpecEdit } from '../src/shared/spec';

const root = path.resolve(__dirname, '..', '..', 'sample');

const intents: EditIntent[] = [
  // Hierarchy: one CPU composite + a top-level memory.
  { kind: 'addComponent', id: 'CPU0', label: 'Core 0', nodeKind: 'composite' },
  { kind: 'addComponent', id: 'CPU0.IF', label: 'Instruction Fetch' },
  { kind: 'addComponent', id: 'CPU0.DE', label: 'Decode' },
  { kind: 'addComponent', id: 'CPU0.EX', label: 'Execute' },
  { kind: 'addComponent', id: 'CPU0.MEM', label: 'Memory Access' },
  { kind: 'addComponent', id: 'CPU0.WB', label: 'Writeback' },
  { kind: 'addComponent', id: 'CPU0.Control', label: 'Hazard Control' },
  { kind: 'addComponent', id: 'Memory1', label: 'Main Memory' },

  // Messages.
  { kind: 'addEvent', id: 'FetchEvent', fields: [{ name: 'pc', type: 'uint32_t' }, { name: 'instruction', type: 'uint32_t' }] },
  { kind: 'addEvent', id: 'DecodeEvent', fields: [{ name: 'opcode', type: 'uint32_t' }, { name: 'rd', type: 'uint32_t' }] },
  { kind: 'addEvent', id: 'ExecEvent', fields: [{ name: 'value', type: 'uint32_t' }] },
  { kind: 'addEvent', id: 'MemRequest', fields: [{ name: 'addr', type: 'uint32_t' }, { name: 'value', type: 'uint32_t' }] },
  { kind: 'addEvent', id: 'MemEvent', fields: [{ name: 'value', type: 'uint32_t' }] },
  { kind: 'addEvent', id: 'BranchEvent', fields: [{ name: 'taken', type: 'bool' }, { name: 'target', type: 'uint32_t' }] },
  { kind: 'addEvent', id: 'StallEvent', fields: [] },

  // Wires inside the core…
  { kind: 'addWire', from: 'CPU0.IF', port: 'out', message: 'FetchEvent', to: 'CPU0.DE', latency: 1 },
  { kind: 'addWire', from: 'CPU0.DE', port: 'out', message: 'DecodeEvent', to: 'CPU0.EX', latency: 1 },
  { kind: 'addWire', from: 'CPU0.EX', port: 'out', message: 'ExecEvent', to: 'CPU0.MEM', latency: 1 },
  { kind: 'addWire', from: 'CPU0.EX', port: 'branch', message: 'BranchEvent', to: 'CPU0.Control', latency: 0 },
  { kind: 'addWire', from: 'CPU0.MEM', port: 'out', message: 'MemEvent', to: 'CPU0.WB', latency: 1 },
  { kind: 'addWire', from: 'CPU0.Control', port: 'stall', message: 'StallEvent', to: 'CPU0.IF', latency: 1 },
  // …and one crossing the composite boundary to the top-level memory.
  { kind: 'addWire', from: 'CPU0.MEM', port: 'mem', message: 'MemRequest', to: 'Memory1', latency: 2 },

  // State variables — real C++ members, visible on the canvas.
  { kind: 'setVars', id: 'CPU0.IF', vars: [{ name: 'pc', type: 'uint32_t', init: '0x80000000' }] },
  { kind: 'setVars', id: 'CPU0.DE', vars: [
    { name: 'instruction', type: 'uint32_t', init: null },
    { name: 'opcode', type: 'uint32_t', init: null },
  ] },
  { kind: 'setVars', id: 'CPU0.EX', vars: [{ name: 'result', type: 'uint32_t', init: null }] },
  { kind: 'setVars', id: 'CPU0.WB', vars: [{ name: 'retired', type: 'uint64_t', init: '0' }] },
  { kind: 'setVars', id: 'Memory1', vars: [{ name: 'accesses', type: 'uint64_t', init: '0' }] },
];

const model = intents.reduce(applyIntent, EMPTY_MODEL);

// Seed the architecture SPEC (only if the project doesn't have one yet) —
// the spec drives inc/iss_arch.h (types, signals, global state).
if (!loadSpec(root)) {
  saveSpec(
    root,
    applySpecEdit(structuredClone(TEMPLATE_RV32I), {
      kind: 'setMeta',
      name: 'RV32 SoC (1× Core 0 + main memory)',
    }),
  );
}

const written = writeModel(root, model, loadSpec(root));
written.push(writeHarness(root, model));
written.push(specPath(root));
console.log(written.map((f) => path.relative(root, f)).join('\n'));
