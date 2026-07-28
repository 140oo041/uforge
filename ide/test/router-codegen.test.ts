// Top-level router fabric — the CODEGEN half: harness emission (Router
// construction, addMatchRule/addRoute/routeVia), router source files, and the
// parser round-trip guard that routers stay sidecar-only and generated block
// code is left untouched.
//
// Derivation lives in fabric.test.ts; the engine-backed proof lives in
// e2e-fabric.test.ts.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { applyIntent } from '@iss/host/writer/edits';
import { writeModel } from '@iss/host/writer/index';
import { emitHarness } from '@iss/host/writer/harness';
import { emitRouterBody } from '@iss/host/writer/routerfile';
import { parseProject } from '@iss/host/parser/index';
import { augmentWithModel } from '@iss/host/project/augment';
import { buildModel, fabricModel, ruleFabricModel, tmp } from './helpers/fabric';

describe('harness fabric codegen', () => {
  it('includes router sources, instantiates their classes, wires rules and routes', () => {
    const text = emitHarness(ruleFabricModel());
    // The generated src/<R>.cpp class, not a bare microarch::Router.
    expect(text).toContain('#include "R0.cpp"');
    expect(text).toContain('R0 r_R0(scheduler);');
    expect(text).not.toContain('microarch::Router r_R0');
    expect(text).toContain('scheduler.addClocked(r_R0);');
    // Ingress rule at the attachment router; dest-keyed hop tables after.
    expect(text).toContain('r_R0.addMatchRule("Ping", 0x0ULL, 0xffffffffffffffffULL, "B");');
    expect(text).toContain('r_R0.addRoute("B", r_R1);');
    expect(text).toContain('r_R1.addRoute("B", s_B);');
    // Destination-less ingress: the router resolves, not the link.
    expect(text).toContain('link_A_out.routeVia(r_R0);');
    expect(text).not.toContain('routeVia(r_R0, "B")');
    // Honesty print for packets stranded at clock stop.
    expect(text).toContain('r_R0.pendingCount()');
    // Routers are not blocks: no registry entry, no seed.
    expect(text).not.toContain('registry.add("R0"');
    // No model assigned → flat constant, no setRouteLatency.
    expect(text).not.toContain('setRouteLatency');
    // Rule destinations are fed by the fabric — the entry heuristic must
    // not seed B.
    expect(text).not.toContain('scheduler.seed(std::make_unique<Ping>(), s_B');
  });

  it('emits address bounds and binds a rule latency model on every path router', () => {
    const m = applyIntent(ruleFabricModel(), {
      kind: 'updateForwardingRule',
      router: 'R0',
      index: 0,
      rule: {
        message: 'Ping',
        addrLo: '0x1000',
        addrHi: '0x1fff',
        to: 'B',
        latencyModel: 'congested',
      },
    });
    const text = emitHarness(m);
    expect(text).toContain('r_R0.addMatchRule("Ping", 0x1000ULL, 0x1fffULL, "B");');
    expect(text).toContain(
      'r_R0.setRouteLatency("B", [&](const microarch::Event& ev) { return r_R0.congested(ev); });',
    );
    expect(text).toContain(
      'r_R1.setRouteLatency("B", [&](const microarch::Event& ev) { return r_R1.congested(ev); });',
    );
  });

  it('cross-top wires are loud FABRIC ERRORs and emit no fabric transport', () => {
    const text = emitHarness(fabricModel()); // legacy fixture: A --Ping--> B wire
    expect(text).not.toContain('.routeVia(');
    expect(text).not.toContain('.addMatchRule(');
    expect(text).not.toContain('.addRoute(');
    expect(text).toContain('FABRIC ERROR: A.out');
    expect(text).toContain('crosses top-level components');
    expect(text).toContain('the IDE will not Run this design');
  });

  it('a model with no routers and no cross-top wires emits no fabric surface', () => {
    const m = buildModel([
      { kind: 'addComponent', id: 'Unit1', nodeKind: 'composite' },
      { kind: 'addComponent', id: 'Unit1.A' },
      { kind: 'addComponent', id: 'Unit1.B' },
      { kind: 'addEvent', id: 'Ping', fields: [] },
      { kind: 'addWire', from: 'Unit1.A', port: 'out', message: 'Ping', to: 'Unit1.B', latency: 1 },
    ]);
    const text = emitHarness(m);
    expect(text).not.toContain('Router');
    expect(text).not.toContain('FABRIC');
    expect(text).not.toContain('pendingCount');
  });
});

describe('round-trip with routers', () => {
  it('router .cpp files round-trip: class parses as a router with its models', () => {
    const root = tmp();
    const model = fabricModel();
    writeModel(root, model);

    // Routers are real components now: one src/<R>.cpp each, no .sv twin.
    const r0File = path.join(root, 'src', 'R0.cpp');
    expect(fs.existsSync(r0File)).toBe(true);
    expect(fs.existsSync(path.join(root, 'src', 'R0.sv'))).toBe(false);
    const text = fs.readFileSync(r0File, 'utf8');
    expect(text).toContain('class R0 : public microarch::Router');
    expect(text).toContain('microarch::Cycle flat(const microarch::Event&) const { return 1; }');

    // A hand-written model below the markers survives and is parsed.
    fs.writeFileSync(
      r0File,
      text.replace('};', 'microarch::Cycle congested(const microarch::Event& event) {\n' +
        '        return event.token % 2 == 0 ? 4 : 1;\n    }\n};'),
    );
    writeModel(root, model); // regeneration must not clobber the hand model
    expect(fs.readFileSync(r0File, 'utf8')).toContain('congested');

    const parsed = parseProject([root]);
    const byId = new Map(parsed.components.map((c) => [c.id, c]));
    // The two blocks parse as before; the drawn wire is still Tier-1 wired.
    const link = parsed.links.find((l) => l.id === 'A.out')!;
    expect(link.status).toBe('wired');
    expect(link.to).toBe('B');
    // Router classes parse as kind 'router' with their latency models.
    expect(byId.get('R0')!.kind).toBe('router');
    expect(byId.get('R0')!.latencyModels).toEqual(['flat', 'congested']);
    expect(byId.get('R1')!.kind).toBe('router');
    expect(byId.get('R1')!.latencyModels).toEqual(['flat']);
    // Routers never gain ports/consumes from their source.
    expect(byId.get('R0')!.outPorts).toEqual([]);

    const augmented = augmentWithModel(parsed, model);
    const kinds = new Map(augmented.components.map((c) => [c.id, c.kind]));
    expect(kinds.get('R0')).toBe('router');
    expect(augmented.components.find((c) => c.id === 'R0')!.routerLatency).toBe(1);
    expect(augmented.fabric).toEqual({
      attachments: [
        { component: 'A', router: 'R0' },
        { component: 'B', router: 'R1' },
      ],
      trunks: [{ a: 'R0', b: 'R1' }],
    });
    // The legacy cross-top wire is a hard error now, not a routed transport.
    expect(augmented.links.find((l) => l.id === 'A.out')!.fabricError).toContain(
      'crosses top-level components',
    );
  });

  it('rule-based round-trip: fabric-bound port surfaces as a routed link with rules merged', () => {
    const root = tmp();
    const model = ruleFabricModel();
    writeModel(root, model);
    const augmented = augmentWithModel(parseProject([root]), model);
    const link = augmented.links.find((l) => l.id === 'A.out')!;
    expect(link.status).toBe('routed');
    expect(link.to).toBeNull();
    expect(link.via).toEqual(['R0']);
    expect(link.fabricError).toBeUndefined();
    expect(augmented.stubs).toEqual([]);
    expect(augmented.components.find((c) => c.id === 'R0')!.rules).toEqual([
      { message: 'Ping', to: 'B' },
    ]);
    expect(augmented.derived).toEqual([
      { fromTop: 'A', toTop: 'B', router: 'R0', ruleIndex: 0, message: 'Ping' },
    ]);
    expect(augmented.diagnostics ?? []).toEqual([]);
    // Removing the rule degrades the port to a pointed stub, not silence.
    const without = applyIntent(model, { kind: 'removeForwardingRule', router: 'R0', index: 0 });
    const degraded = augmentWithModel(parseProject([root]), without);
    expect(degraded.links.find((l) => l.id === 'A.out')).toBeUndefined();
    expect(degraded.stubs).toEqual([
      { from: 'A', port: 'out', message: 'Ping', reason: 'no forwarding rule on R0 matches Ping' },
    ]);
  });

  it('removing a router retires its generated source file', () => {
    const root = tmp();
    const model = fabricModel();
    writeModel(root, model);
    expect(fs.existsSync(path.join(root, 'src', 'R1.cpp'))).toBe(true);
    const without = applyIntent(model, { kind: 'removeComponent', id: 'R1' });
    writeModel(root, without);
    expect(fs.existsSync(path.join(root, 'src', 'R1.cpp'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src', 'R0.cpp'))).toBe(true);
  });
});

describe('router config codegen', () => {
  it('default config keeps the bodyless ctor', () => {
    const m = fabricModel();
    const body = emitRouterBody(m.components.find((c) => c.id === 'R0')!, m);
    expect(body).toContain(': microarch::Router("R0", scheduler, 1) {}');
    expect(body).not.toContain('setArbitration');
  });

  it('non-default config emits ctor calls; composite attachments expand per leaf', () => {
    let m = buildModel([
      { kind: 'addComponent', id: 'CPU0', nodeKind: 'composite' },
      { kind: 'addComponent', id: 'CPU0.IF' },
      { kind: 'addComponent', id: 'CPU0.MEM' },
      { kind: 'addComponent', id: 'Mem1' },
      { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
      { kind: 'attachRouter', id: 'CPU0', router: 'R0', attach: true },
      { kind: 'attachRouter', id: 'Mem1', router: 'R0', attach: true },
    ]);
    m = applyIntent(m, { kind: 'setRouterArbitration', id: 'R0', policy: 'weighted' });
    m = applyIntent(m, { kind: 'setRouterBandwidth', id: 'R0', bandwidthBits: 64 });
    m = applyIntent(m, { kind: 'setRouterQueue', id: 'R0', capacity: 4, fullPolicy: 'drop' });
    m = applyIntent(m, { kind: 'setAttachmentPolicy', router: 'R0', component: 'CPU0', weight: 2 });
    m = applyIntent(m, { kind: 'setAttachmentPolicy', router: 'R0', component: 'Mem1', priority: 1 });

    const body = emitRouterBody(m.components.find((c) => c.id === 'R0')!, m);
    expect(body).toContain('setArbitration(Arbitration::Weighted);');
    expect(body).toContain('setBandwidth(64);'); // bits per port per cycle
    expect(body).toContain('setQueueCapacity(4);');
    expect(body).toContain('setFullPolicy(FullPolicy::Drop);');
    // The composite attachment covers every leaf under it — origins are leaves.
    expect(body).toContain('setSourceWeight("CPU0.IF", 2);');
    expect(body).toContain('setSourceWeight("CPU0.MEM", 2);');
    expect(body).toContain('setSourcePriority("Mem1", 1);');
    expect(body).not.toContain('setSourceWeight("CPU0"'); // never the composite itself
  });

  it('config survives write → parse → augment', () => {
    const root = tmp();
    let m = fabricModel();
    m = applyIntent(m, { kind: 'setRouterArbitration', id: 'R0', policy: 'priority' });
    m = applyIntent(m, { kind: 'setRouterBandwidth', id: 'R0', bandwidthBits: 128 });
    m = applyIntent(m, { kind: 'setRouterQueue', id: 'R0', capacity: 8, fullPolicy: 'drop' });
    m = applyIntent(m, { kind: 'setAttachmentPolicy', router: 'R0', component: 'A', priority: 0 });
    writeModel(root, m);

    const graph = augmentWithModel(parseProject([root]), m);
    const r0 = graph.components.find((c) => c.id === 'R0')!;
    expect(r0.kind).toBe('router');
    expect(r0.arbitration).toBe('priority');
    expect(r0.portBandwidthBits).toBe(128);
    expect(r0.queueCapacity).toBe(8);
    expect(r0.fullPolicy).toBe('drop');
    expect(r0.attachmentPolicy).toEqual({ A: { priority: 0 } });
  });
});
