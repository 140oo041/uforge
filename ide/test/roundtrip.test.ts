// THE P0 acceptance (DESIGN_PLAN v3 §3.5), extended for v2 hierarchy: author
// a 12-wire design on the canvas (including a composite with inner blocks and
// cross-boundary wires), write it to C++ — ONE .cpp per block, no .h —
// reparse, and get 12 links, 0 stubs, all Tier-1 'wired', with multi-port
// blocks keeping distinct event types per port and state variables intact.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EMPTY_MODEL, type AuthoringModel, type EditIntent } from '@iss/contracts/model';
import { applyIntent } from '@iss/host/writer/edits';
import { writeModel, writeHarness, openModel } from '@iss/host/writer/index';
import { BEGIN_MARKER, END_MARKER } from '@iss/host/writer/markers';
import { parseProject } from '@iss/host/parser/index';

function buildModel(intents: EditIntent[]): AuthoringModel {
  return intents.reduce(applyIntent, EMPTY_MODEL);
}

const EVENTS = [
  'FetchEvent',
  'DecodeEvent',
  'ExecuteEvent',
  'MemEvent',
  'WritebackEvent',
  'BranchEvent',
  'StallEvent',
  'ForwardEvent',
  'CommitEvent',
  'FlushEvent',
  'PredictEvent',
  'RetireEvent',
];

// A composite CPU0 with the pipeline inside + top-level Memory/Retire/Sink.
// 12 wires total; EX and Control have multiple out-ports carrying DIFFERENT
// event types (the makeUniqueByClass killer). All wires stay inside CPU0:
// cross-top wires are not allowed (fabric rules own inter-unit dataflow).
const WIRES: Array<{ from: string; port: string; message: string; to: string; latency?: number }> = [
  { from: 'CPU0.IF', port: 'out', message: 'FetchEvent', to: 'CPU0.DE' },
  { from: 'CPU0.DE', port: 'out', message: 'DecodeEvent', to: 'CPU0.EX', latency: 1 },
  { from: 'CPU0.EX', port: 'out', message: 'ExecuteEvent', to: 'CPU0.MEM', latency: 1 },
  { from: 'CPU0.EX', port: 'branch', message: 'BranchEvent', to: 'CPU0.Control', latency: 0 },
  { from: 'CPU0.EX', port: 'fwd', message: 'ForwardEvent', to: 'CPU0.DE', latency: 0 },
  { from: 'CPU0.MEM', port: 'out', message: 'MemEvent', to: 'CPU0.Memory' },
  { from: 'CPU0.WB', port: 'out', message: 'WritebackEvent', to: 'CPU0.Retire' },
  { from: 'CPU0.Control', port: 'stall', message: 'StallEvent', to: 'CPU0.IF' },
  { from: 'CPU0.Control', port: 'flush', message: 'FlushEvent', to: 'CPU0.DE' },
  { from: 'CPU0.MEM', port: 'wb', message: 'CommitEvent', to: 'CPU0.WB', latency: 2 },
  { from: 'CPU0.Memory', port: 'out', message: 'PredictEvent', to: 'CPU0.Retire' },
  { from: 'CPU0.Retire', port: 'out', message: 'RetireEvent', to: 'CPU0.Sink' },
];

const COMPONENTS: EditIntent[] = [
  { kind: 'addComponent', id: 'CPU0', nodeKind: 'composite' },
  { kind: 'addComponent', id: 'CPU0.IF' },
  { kind: 'addComponent', id: 'CPU0.DE' },
  { kind: 'addComponent', id: 'CPU0.EX' },
  { kind: 'addComponent', id: 'CPU0.MEM' },
  { kind: 'addComponent', id: 'CPU0.WB' },
  { kind: 'addComponent', id: 'CPU0.Control' },
  { kind: 'addComponent', id: 'CPU0.Memory' },
  { kind: 'addComponent', id: 'CPU0.Retire' },
  { kind: 'addComponent', id: 'CPU0.Sink' },
];
const LEAVES = COMPONENTS.slice(1).map((c) => (c as { id: string }).id);

function twelveWireModel(): AuthoringModel {
  const intents: EditIntent[] = [
    ...COMPONENTS,
    ...EVENTS.map((id): EditIntent => ({ kind: 'addEvent', id })),
    ...WIRES.map(
      (w): EditIntent => ({
        kind: 'addWire',
        from: w.from,
        port: w.port,
        message: w.message,
        to: w.to,
        latency: w.latency ?? null,
      }),
    ),
    {
      kind: 'setVars',
      id: 'CPU0.IF',
      vars: [{ name: 'pc', type: 'uint32_t', init: '0x80000000' }],
    },
    {
      kind: 'setVars',
      id: 'CPU0.DE',
      vars: [
        { name: 'instruction', type: 'uint32_t', init: null },
        { name: 'opcode', type: 'uint32_t', init: null },
      ],
    },
  ];
  return buildModel(intents);
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-roundtrip-'));
}

describe('P0 keystone: drawn wires persist through write → reparse', () => {
  it('12 drawn wires → 12 wired links, 0 stubs (hierarchy included)', () => {
    const root = tmpProject();
    writeModel(root, twelveWireModel());

    const graph = parseProject([root]);

    expect(graph.links).toHaveLength(12);
    expect(graph.stubs).toHaveLength(0);
    expect(graph.links.every((l) => l.status === 'wired')).toBe(true);

    for (const wire of WIRES) {
      const link = graph.links.find((l) => l.from === wire.from && l.fromPort === wire.port);
      expect(link, `${wire.from}.${wire.port}`).toBeDefined();
      expect(link!.to).toBe(wire.to);
      expect(link!.message).toBe(wire.message);
      expect(link!.latency).toBe(wire.latency ?? 1);
    }
  });

  it('one .cpp per block, no generated headers, namespaced by composite', () => {
    const root = tmpProject();
    writeModel(root, twelveWireModel());

    expect(fs.existsSync(path.join(root, 'src', 'CPU0', 'IF.cpp'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src', 'CPU0', 'Memory.cpp'))).toBe(true);
    // Two generated headers: the shared arch header + the events header.
    expect(fs.readdirSync(path.join(root, 'inc'))).toEqual(['iss_arch.h', 'iss_events.h']);

    const ifCpp = fs.readFileSync(path.join(root, 'src', 'CPU0', 'IF.cpp'), 'utf8');
    expect(ifCpp).toContain('#pragma once');
    expect(ifCpp).toContain('namespace CPU0 {');
    expect(ifCpp).toContain('Component("CPU0.IF")');
    expect(ifCpp).toContain('uint32_t pc = 0x80000000;');
  });

  it('composites round-trip: parsed graph has CPU0 with children and vars', () => {
    const root = tmpProject();
    writeModel(root, twelveWireModel());
    const graph = parseProject([root]);

    const cpu = graph.components.find((c) => c.id === 'CPU0')!;
    expect(cpu.kind).toBe('composite');
    const ifComp = graph.components.find((c) => c.id === 'CPU0.IF')!;
    expect(ifComp.kind).toBe('leaf');
    expect(ifComp.parent).toBe('CPU0');
    expect(ifComp.vars).toEqual(['pc:uint32_t']);
    const de = graph.components.find((c) => c.id === 'CPU0.DE')!;
    expect(de.vars.sort()).toEqual(['instruction:uint32_t', 'opcode:uint32_t']);
    // Handler locals must NOT leak into vars.
    expect(de.vars.some((v) => v.startsWith('ev_') || v.includes(':auto'))).toBe(false);
  });

  it('multi-port blocks keep one distinct message per (class, port)', () => {
    const root = tmpProject();
    writeModel(root, twelveWireModel());
    const graph = parseProject([root]);

    const ex = graph.components.find((c) => c.id === 'CPU0.EX')!;
    expect(ex.outPorts.map((p) => `${p.name}:${p.message}`).sort()).toEqual([
      'branch:BranchEvent',
      'fwd:ForwardEvent',
      'out:ExecuteEvent',
    ]);
  });

  it('duplicateComponent clones a composite subtree with independent code', () => {
    const root = tmpProject();
    let model = twelveWireModel();
    model = applyIntent(model, { kind: 'duplicateComponent', id: 'CPU0', newId: 'CPU1' });
    writeModel(root, model);

    expect(fs.existsSync(path.join(root, 'src', 'CPU1', 'IF.cpp'))).toBe(true);
    const graph = parseProject([root]);
    const if1 = graph.components.find((c) => c.id === 'CPU1.IF')!;
    expect(if1.parent).toBe('CPU1');
    expect(if1.vars).toEqual(['pc:uint32_t']);
    // Internal wires (including deeper subtree targets) remap into CPU1.
    const stall = graph.links.find((l) => l.id === 'CPU1.Control.stall')!;
    expect(stall.to).toBe('CPU1.IF');
    const mem = graph.links.find((l) => l.id === 'CPU1.MEM.out')!;
    expect(mem.to).toBe('CPU1.Memory');
    expect(graph.links.every((l) => l.status === 'wired')).toBe(true);
  });

  it('legacy two-file blocks migrate: generated .h deleted, .cpp rewritten', () => {
    const root = tmpProject();
    // Fake a legacy layout for one block.
    fs.mkdirSync(path.join(root, 'inc'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'CPU0'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'inc', 'Memory.h'),
      `#pragma once\n${BEGIN_MARKER}\nclass Memory : public Component {};\n${END_MARKER}\n`,
    );
    fs.writeFileSync(
      path.join(root, 'src', 'CPU0', 'Memory.cpp'),
      `#include "Memory.h"\n${BEGIN_MARKER}\nMemory::Memory() : Component("CPU0.Memory") {}\n${END_MARKER}\n`,
    );
    writeModel(root, twelveWireModel());

    expect(fs.existsSync(path.join(root, 'inc', 'Memory.h'))).toBe(false);
    const memory = fs.readFileSync(path.join(root, 'src', 'CPU0', 'Memory.cpp'), 'utf8');
    expect(memory).not.toContain('#include "Memory.h"');
    expect(memory).toContain('#pragma once');
  });

  it('a dangling wire (to: null) is a visible stub, not a lost edge', () => {
    const root = tmpProject();
    const model = buildModel([
      { kind: 'addComponent', id: 'A' },
      { kind: 'addEvent', id: 'PingEvent' },
      { kind: 'addWire', from: 'A', port: 'out', message: 'PingEvent', to: null },
    ]);
    writeModel(root, model);
    const graph = parseProject([root]);
    expect(graph.links).toHaveLength(0);
    expect(graph.stubs).toHaveLength(1);
    expect(graph.stubs[0]).toMatchObject({ from: 'A', port: 'out', message: 'PingEvent' });
  });

  it('removing a composite removes its subtree and dangles inbound wires', () => {
    const root = tmpProject();
    let model = twelveWireModel();
    model = applyIntent(model, { kind: 'removeComponent', id: 'CPU0' });
    writeModel(root, model);
    const graph = parseProject([root]);
    expect(graph.components.some((c) => c.id.startsWith('CPU0'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src', 'CPU0'))).toBe(false);
  });

  it('sidecar round-trips and re-write is byte-identical (deterministic)', () => {
    const root = tmpProject();
    const model = twelveWireModel();
    writeModel(root, model);
    const loaded = openModel(root).model;
    expect(loaded).toEqual(model);

    const snapshot = new Map<string, string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else snapshot.set(full, fs.readFileSync(full, 'utf8'));
      }
    };
    walk(path.join(root, 'src'));
    walk(path.join(root, 'inc'));

    writeModel(root, loaded);
    for (const [file, before] of snapshot)
      expect(fs.readFileSync(file, 'utf8'), file).toBe(before);
  });

  it('hand edits outside the marker region survive regeneration', () => {
    const root = tmpProject();
    const model = twelveWireModel();
    writeModel(root, model);
    const source = path.join(root, 'src', 'CPU0', 'EX.cpp');
    const hand = fs.readFileSync(source, 'utf8') + '\n// my hand-written note\nstatic inline int myHelper() { return 42; }\n';
    fs.writeFileSync(source, hand);

    writeModel(
      root,
      applyIntent(model, { kind: 'setLatency', from: 'CPU0.EX', port: 'out', latency: 3 }),
    );

    const text = fs.readFileSync(source, 'utf8');
    expect(text).toContain('my hand-written note');
    expect(text).toContain('myHelper');
    expect(text).toContain('->latency = 3');
  });

  it('generates a harness that instantiates every leaf with qualified types', () => {
    const root = tmpProject();
    const model = twelveWireModel();
    writeModel(root, model);
    const harness = fs.readFileSync(writeHarness(root, model), 'utf8');
    for (const leaf of LEAVES) {
      const type = leaf.split('.').join('::');
      const instance = 's_' + leaf.split('.').join('_');
      expect(harness).toMatch(new RegExp(`${type} ${instance}[(;]`));
      expect(harness).toContain(`registry.add("${leaf}", ${instance});`);
      expect(harness).toContain(`${instance}.wire(registry);`);
    }
    expect(harness).toContain('#include "CPU0/IF.cpp"');
    expect(harness).toContain('setHopSink');
    expect(harness).toContain('seed');
    // Composites are never instantiated.
    expect(harness).not.toMatch(/\bCPU0 s_CPU0\b/);
  });

  it('spec types/signals in the arch header round-trip without phantom nodes', () => {
    const root = tmpProject();
    const spec = {
      name: 'Accel',
      kind: 'accelerator',
      types: [{ name: 'word', base: 'uint32_t' }],
      signals: [{ name: 'Phase', underlying: 'uint8_t', values: ['IDLE', 'RUN'] as string[] }],
      io: [],
      state: [{ name: 'pc', label: 'pc', bits: 32, type: 'word', init: '0x80000000' }],
      operations: [],
    };
    const model = buildModel([
      { kind: 'addComponent', id: 'S', nodeKind: 'composite' },
      { kind: 'addComponent', id: 'S.A' },
      { kind: 'addComponent', id: 'S.B' },
      { kind: 'addEvent', id: 'PingEvent', fields: [{ name: 'v', type: 'word' }] },
      { kind: 'addWire', from: 'S.A', port: 'out_A_to_B', message: 'PingEvent', to: 'S.B', latency: 1 },
      // Vars typed by the spec alias and the signal enum.
      { kind: 'setVars', id: 'S.A', vars: [{ name: 'phase', type: 'Phase', init: null }] },
    ]);
    writeModel(root, model, spec);

    // The arch header exists and the events header includes it.
    const arch = fs.readFileSync(path.join(root, 'inc', 'iss_arch.h'), 'utf8');
    expect(arch).toContain('using word = uint32_t;');
    expect(arch).toContain('enum class Phase : uint8_t {');
    expect(arch).toContain('word pc = 0x80000000;');
    expect(fs.readFileSync(path.join(root, 'inc', 'iss_events.h'), 'utf8')).toContain(
      '#include "iss_arch.h"',
    );
    // Signal-typed var defaults to its first enumerator.
    expect(fs.readFileSync(path.join(root, 'src', 'S', 'A.cpp'), 'utf8')).toContain(
      'Phase phase = Phase::IDLE;',
    );

    // Reparse: ArchState / Phase / word must NOT surface as components or
    // events, and the wire stays Tier-1 wired.
    const graph = parseProject([root]);
    const ids = graph.components.map((c) => c.id);
    expect(ids.sort()).toEqual(['S', 'S.A', 'S.B']);
    expect(graph.events.map((e) => e.id)).toEqual(['PingEvent']);
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0].status).toBe('wired');
    expect(graph.stubs).toHaveLength(0);
  });

  it('fan-out: two destination-named ports out of one block both stay wired', () => {
    const root = tmpProject();
    const model = buildModel([
      { kind: 'addComponent', id: 'S', nodeKind: 'composite' },
      { kind: 'addComponent', id: 'S.A' },
      { kind: 'addComponent', id: 'S.B' },
      { kind: 'addComponent', id: 'S.C' },
      { kind: 'addEvent', id: 'PingEvent' },
      { kind: 'addEvent', id: 'PongEvent' },
      // The canvas names each new wire's port out_<from>_to_<to>.
      { kind: 'addWire', from: 'S.A', port: 'out_A_to_B', message: 'PingEvent', to: 'S.B', latency: 1 },
      { kind: 'addWire', from: 'S.A', port: 'out_A_to_C', message: 'PongEvent', to: 'S.C', latency: 2 },
    ]);
    writeModel(root, model);
    const graph = parseProject([root]);

    expect(graph.links).toHaveLength(2);
    expect(graph.stubs).toHaveLength(0);
    const toB = graph.links.find((l) => l.fromPort === 'out_A_to_B')!;
    const toC = graph.links.find((l) => l.fromPort === 'out_A_to_C')!;
    expect(toB.to).toBe('S.B');
    expect(toB.message).toBe('PingEvent');
    expect(toB.status).toBe('wired');
    expect(toC.to).toBe('S.C');
    expect(toC.message).toBe('PongEvent');
    expect(toC.latency).toBe(2);
    expect(toC.status).toBe('wired');
  });
});
