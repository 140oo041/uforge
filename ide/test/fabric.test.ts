// Top-level router fabric — the AUTHORING and DERIVATION half: router intents
// through the reducer, and deriveFabric's rule-based routing (ingress binding,
// address-split rules, destination resolution, and every diagnostic).
//
// Codegen lives in router-codegen.test.ts; the engine-backed proof lives in
// e2e-fabric.test.ts. Split out of one 878-line file so that a change to any
// one of the three produces a readable diff.

import { describe, expect, it } from 'vitest';

import { deriveFabric, topOf } from '@iss/contracts/fabric';
import { applyIntent } from '@iss/host/writer/edits';
import { buildModel, fabricModel, ruleFabricModel } from './helpers/fabric';

describe('router intents', () => {
  it('routers are top-level only and cannot take wires', () => {
    let m = buildModel([{ kind: 'addComponent', id: 'Unit1', nodeKind: 'composite' }]);
    expect(() =>
      applyIntent(m, { kind: 'addComponent', id: 'Unit1.R0', nodeKind: 'router' }),
    ).toThrow(/top level/);
    m = applyIntent(m, { kind: 'addComponent', id: 'R0', nodeKind: 'router' });
    m = applyIntent(m, { kind: 'addEvent', id: 'E' });
    expect(() =>
      applyIntent(m, { kind: 'addWire', from: 'R0', port: 'out', message: 'E' }),
    ).toThrow(/router/);
  });

  it('attach/detach and symmetric trunks', () => {
    let m = fabricModel();
    const byId = (id: string) => m.components.find((c) => c.id === id)!;
    expect(byId('A').fabric).toEqual(['R0']);
    expect(byId('R0').peers).toEqual(['R1']);
    expect(byId('R1').peers).toEqual(['R0']);

    m = applyIntent(m, { kind: 'attachRouter', id: 'A', router: 'R0', attach: false });
    expect(byId('A').fabric).toBeUndefined();

    m = applyIntent(m, { kind: 'linkRouters', a: 'R1', b: 'R0', connect: false });
    expect(byId('R0').peers).toBeUndefined();
    expect(byId('R1').peers).toBeUndefined();

    expect(() => applyIntent(m, { kind: 'linkRouters', a: 'R0', b: 'R0', connect: true })).toThrow();
    expect(() =>
      applyIntent(m, { kind: 'attachRouter', id: 'R0', router: 'R1', attach: true }),
    ).toThrow();
  });

  it('nested components cannot attach; removing a router sweeps references', () => {
    let m = fabricModel();
    m = applyIntent(m, { kind: 'addComponent', id: 'Unit1', nodeKind: 'composite' });
    m = applyIntent(m, { kind: 'addComponent', id: 'Unit1.S1' });
    expect(() =>
      applyIntent(m, { kind: 'attachRouter', id: 'Unit1.S1', router: 'R0', attach: true }),
    ).toThrow(/top-level/);

    m = applyIntent(m, { kind: 'removeComponent', id: 'R0' });
    const byId = (id: string) => m.components.find((c) => c.id === id)!;
    expect(byId('A').fabric).toBeUndefined(); // was attached to R0
    expect(byId('R1').peers).toBeUndefined(); // trunk to R0 gone
  });

  it('setRouterLatency validates and defaults 1', () => {
    let m = fabricModel();
    m = applyIntent(m, { kind: 'setRouterLatency', id: 'R0', latency: 3 });
    expect(m.components.find((c) => c.id === 'R0')!.routerLatency).toBe(3);
    m = applyIntent(m, { kind: 'setRouterLatency', id: 'R0', latency: 1 });
    expect(m.components.find((c) => c.id === 'R0')!.routerLatency).toBeUndefined();
    expect(() => applyIntent(m, { kind: 'setRouterLatency', id: 'R0', latency: -1 })).toThrow();
    expect(() => applyIntent(m, { kind: 'setRouterLatency', id: 'A', latency: 2 })).toThrow();
  });
});

describe('deriveFabric path selection', () => {
  it('same-router attachment is a single-hop path', () => {
    let m = ruleFabricModel();
    // Move B onto R0 alongside A: the route collapses to one hop.
    m = applyIntent(m, { kind: 'attachRouter', id: 'B', router: 'R1', attach: false });
    m = applyIntent(m, { kind: 'attachRouter', id: 'B', router: 'R0', attach: true });
    expect(deriveFabric(m).ruleRoutes[0].path).toEqual(['R0']);
  });

  it('a destination on multiple routers rides the shortest available path', () => {
    // B@R1 over the R0—R1 trunk is 2 hops; also attaching B to R0 directly
    // collapses the rule's route to a single hop.
    let m = ruleFabricModel();
    expect(deriveFabric(m).ruleRoutes[0].path).toEqual(['R0', 'R1']);
    m = applyIntent(m, { kind: 'attachRouter', id: 'B', router: 'R0', attach: true });
    expect(deriveFabric(m).ruleRoutes[0].path).toEqual(['R0']);
    // Intra-composite ids never touch the fabric.
    expect(topOf('CPU0.IF')).toBe('CPU0');
  });
});

describe('router config intents', () => {
  it('arbitration/bandwidth/queue normalize to absent at their defaults', () => {
    let m = fabricModel();
    const r0 = () => m.components.find((c) => c.id === 'R0')!;

    m = applyIntent(m, { kind: 'setRouterArbitration', id: 'R0', policy: 'weighted' });
    expect(r0().arbitration).toBe('weighted');
    m = applyIntent(m, { kind: 'setRouterArbitration', id: 'R0', policy: 'fifo' });
    expect(r0().arbitration).toBeUndefined();

    m = applyIntent(m, { kind: 'setRouterBandwidth', id: 'R0', bandwidthBits: 96 });
    expect(r0().portBandwidthBits).toBe(96);
    // Back to the default width — stored as absence, so the sidecar stays clean.
    m = applyIntent(m, { kind: 'setRouterBandwidth', id: 'R0', bandwidthBits: 32 });
    expect(r0().portBandwidthBits).toBeUndefined();
    expect(() =>
      applyIntent(m, { kind: 'setRouterBandwidth', id: 'R0', bandwidthBits: 0 }),
    ).toThrow();

    m = applyIntent(m, { kind: 'setRouterQueue', id: 'R0', capacity: 4, fullPolicy: 'drop' });
    expect(r0().queueCapacity).toBe(4);
    expect(r0().fullPolicy).toBe('drop');
    m = applyIntent(m, { kind: 'setRouterQueue', id: 'R0', capacity: 4, fullPolicy: 'stall' });
    expect(r0().fullPolicy).toBeUndefined(); // stall is the default
    m = applyIntent(m, { kind: 'setRouterQueue', id: 'R0', capacity: null });
    expect(r0().queueCapacity).toBeUndefined();
    expect(() => applyIntent(m, { kind: 'setRouterQueue', id: 'R0', capacity: 0 })).toThrow();
  });

  it('attachment policy requires attachment and sweeps on detach/remove', () => {
    let m = fabricModel(); // A@R0, B@R1
    const r0 = () => m.components.find((c) => c.id === 'R0')!;

    expect(() =>
      applyIntent(m, { kind: 'setAttachmentPolicy', router: 'R0', component: 'B', weight: 2 }),
    ).toThrow(/not attached/);

    m = applyIntent(m, { kind: 'setAttachmentPolicy', router: 'R0', component: 'A', weight: 2 });
    expect(r0().attachmentPolicy).toEqual({ A: { weight: 2 } });
    m = applyIntent(m, { kind: 'setAttachmentPolicy', router: 'R0', component: 'A', priority: 0 });
    expect(r0().attachmentPolicy).toEqual({ A: { weight: 2, priority: 0 } });

    // Weight 1 is the engine default — normalized away.
    m = applyIntent(m, { kind: 'setAttachmentPolicy', router: 'R0', component: 'A', weight: 1 });
    expect(r0().attachmentPolicy).toEqual({ A: { priority: 0 } });
    m = applyIntent(m, {
      kind: 'setAttachmentPolicy',
      router: 'R0',
      component: 'A',
      priority: null,
    });
    expect(r0().attachmentPolicy).toBeUndefined();

    m = applyIntent(m, { kind: 'setAttachmentPolicy', router: 'R0', component: 'A', weight: 3 });
    m = applyIntent(m, { kind: 'attachRouter', id: 'A', router: 'R0', attach: false });
    expect(r0().attachmentPolicy).toBeUndefined(); // swept with the detach

    m = applyIntent(m, { kind: 'attachRouter', id: 'A', router: 'R0', attach: true });
    m = applyIntent(m, { kind: 'setAttachmentPolicy', router: 'R0', component: 'A', weight: 3 });
    m = applyIntent(m, { kind: 'removeComponent', id: 'A' });
    expect(r0().attachmentPolicy).toBeUndefined(); // swept with the removal
  });
});

describe('deriveFabric', () => {
  it('binds ingress, resolves the rule route, and derives the edge', () => {
    const d = deriveFabric(ruleFabricModel());
    expect(d.diagnostics).toEqual([]);
    expect(d.ingress).toEqual([
      { from: 'A', port: 'out', message: 'Ping', router: 'R0', matched: true },
    ]);
    expect(d.ruleRoutes).toEqual([
      {
        router: 'R0',
        ruleIndex: 0,
        message: 'Ping',
        destTop: 'B',
        destLeaf: 'B',
        path: ['R0', 'R1'],
      },
    ]);
    expect(d.derivedEdges).toEqual([
      { fromTop: 'A', toTop: 'B', router: 'R0', ruleIndex: 0, message: 'Ping' },
    ]);
  });

  it('flags cross-top wires as errors', () => {
    const d = deriveFabric(fabricModel()); // legacy fixture: A --Ping--> B wire
    const errors = d.diagnostics.filter((x) => x.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('crossTopWire');
    expect(errors[0].link).toBe('A.out');
    expect(errors[0].detail).toContain('forwarding rule');
  });

  it('warns on unmatched ports and still binds ingress', () => {
    let m = ruleFabricModel();
    m = applyIntent(m, { kind: 'removeForwardingRule', router: 'R0', index: 0 });
    const d = deriveFabric(m);
    expect(d.ingress).toEqual([
      { from: 'A', port: 'out', message: 'Ping', router: 'R0', matched: false },
    ]);
    const warn = d.diagnostics.find((x) => x.kind === 'unmatchedPort');
    expect(warn?.severity).toBe('warning');
    expect(warn?.detail).toContain('dropped');
    expect(d.ruleRoutes).toEqual([]);
  });

  it('resolves composite destinations by message, preferring in-pins', () => {
    let m = ruleFabricModel();
    m = applyIntent(m, { kind: 'addComponent', id: 'Sys', nodeKind: 'composite' });
    m = applyIntent(m, { kind: 'addComponent', id: 'Sys.Rx', io: 'in' });
    m = applyIntent(m, { kind: 'addComponent', id: 'Sys.Core' });
    m = applyIntent(m, { kind: 'setConsumes', id: 'Sys.Rx', consumes: ['Ping'] });
    m = applyIntent(m, { kind: 'setConsumes', id: 'Sys.Core', consumes: ['Ping'] });
    m = applyIntent(m, { kind: 'attachRouter', id: 'Sys', router: 'R1', attach: true });
    m = applyIntent(m, {
      kind: 'updateForwardingRule',
      router: 'R0',
      index: 0,
      rule: { message: 'Ping', to: 'Sys' },
    });
    const d = deriveFabric(m);
    expect(d.ruleRoutes).toHaveLength(1);
    expect(d.ruleRoutes[0].destLeaf).toBe('Sys.Rx'); // the in-pin, not Core
    // Without the pin the two consumers are ambiguous — diagnosed, no route.
    let noPin = applyIntent(m, { kind: 'removeComponent', id: 'Sys.Rx' });
    noPin = applyIntent(noPin, { kind: 'addComponent', id: 'Sys.Core2' });
    noPin = applyIntent(noPin, { kind: 'setConsumes', id: 'Sys.Core2', consumes: ['Ping'] });
    const d2 = deriveFabric(noPin);
    expect(d2.ruleRoutes).toEqual([]);
    expect(d2.diagnostics.some((x) => x.kind === 'ambiguousRuleDest')).toBe(true);
  });

  it('address-split rules fan out to multiple derived edges from one source', () => {
    let m = ruleFabricModel();
    m = applyIntent(m, { kind: 'addComponent', id: 'C' });
    m = applyIntent(m, { kind: 'setConsumes', id: 'C', consumes: ['Ping'] });
    m = applyIntent(m, { kind: 'attachRouter', id: 'C', router: 'R1', attach: true });
    m = applyIntent(m, {
      kind: 'updateForwardingRule',
      router: 'R0',
      index: 0,
      rule: { message: 'Ping', addrLo: '0x0', addrHi: '0xfff', to: 'B' },
    });
    m = applyIntent(m, {
      kind: 'addForwardingRule',
      router: 'R0',
      rule: { message: 'Ping', addrLo: '0x1000', addrHi: '0x1fff', to: 'C' },
    });
    const d = deriveFabric(m);
    expect(d.diagnostics).toEqual([]);
    expect(d.derivedEdges.map((e) => `${e.fromTop}→${e.toTop}`)).toEqual(['A→B', 'A→C']);
    expect(d.derivedEdges[0].addrLo).toBe('0x0');
    expect(d.derivedEdges[1].addrHi).toBe('0x1fff');
    expect(d.ruleRoutes.map((r) => r.destLeaf)).toEqual(['B', 'C']);
  });

  it('any-message rules expand over the messages entering the router', () => {
    let m = ruleFabricModel();
    m = applyIntent(m, { kind: 'addEvent', id: 'Pong', fields: [] });
    m = applyIntent(m, { kind: 'addWire', from: 'A', port: 'out2', message: 'Pong' });
    m = applyIntent(m, { kind: 'setConsumes', id: 'B', consumes: ['Ping', 'Pong'] });
    m = applyIntent(m, {
      kind: 'updateForwardingRule',
      router: 'R0',
      index: 0,
      rule: { to: 'B' }, // any message, any address
    });
    const d = deriveFabric(m);
    expect(d.ruleRoutes.map((r) => r.message).sort()).toEqual(['Ping', 'Pong']);
    expect(d.ruleRoutes.every((r) => r.destLeaf === 'B')).toBe(true);
    // Both ports bind as matched — the any-message rule covers them.
    expect(d.ingress.every((b) => b.matched)).toBe(true);
  });

  it('diagnoses unattached destinations, missing trunks and dangling rule dests', () => {
    let m = ruleFabricModel();
    m = applyIntent(m, { kind: 'attachRouter', id: 'B', router: 'R1', attach: false });
    let d = deriveFabric(m);
    expect(d.ruleRoutes).toEqual([]);
    expect(d.diagnostics.some((x) => x.kind === 'unattachedTop')).toBe(true);

    m = ruleFabricModel();
    m = applyIntent(m, { kind: 'linkRouters', a: 'R0', b: 'R1', connect: false });
    d = deriveFabric(m);
    expect(d.diagnostics.some((x) => x.kind === 'noTrunkPath')).toBe(true);

    m = ruleFabricModel();
    m = applyIntent(m, { kind: 'removeComponent', id: 'B' });
    d = deriveFabric(m);
    expect(d.diagnostics.some((x) => x.kind === 'unresolvableRuleDest')).toBe(true);
    // All rule problems are warnings — only crossTopWire blocks Run.
    expect(d.diagnostics.every((x) => x.severity === 'warning')).toBe(true);
  });

  it('warns when rules bind different latency models to one destination', () => {
    let m = ruleFabricModel();
    m = applyIntent(m, { kind: 'addEvent', id: 'Pong', fields: [] });
    m = applyIntent(m, { kind: 'addWire', from: 'A', port: 'out2', message: 'Pong' });
    m = applyIntent(m, { kind: 'setConsumes', id: 'B', consumes: ['Ping', 'Pong'] });
    m = applyIntent(m, {
      kind: 'updateForwardingRule',
      router: 'R0',
      index: 0,
      rule: { message: 'Ping', to: 'B', latencyModel: 'fast' },
    });
    m = applyIntent(m, {
      kind: 'addForwardingRule',
      router: 'R0',
      rule: { message: 'Pong', to: 'B', latencyModel: 'slow' },
    });
    const d = deriveFabric(m);
    expect(d.diagnostics.some((x) => x.kind === 'conflictingLatencyModel')).toBe(true);
  });
});
