// Top-level router fabric: intents, deriveFabric (rule-based routing),
// harness codegen (Router construction + addRoute/routeVia emission), the
// parser round-trip guard (routers are sidecar-only, generated block code is
// untouched), and a real e2e — hop chains through routers with contention
// serialization, straight from the engine's JSONL trace.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EMPTY_MODEL, type AuthoringModel, type EditIntent } from '@iss/contracts/model';
import { deriveFabric, topOf } from '@iss/contracts/fabric';
import { applyIntent } from '@iss/host/writer/edits';
import { writeHarness, writeModel } from '@iss/host/writer/index';
import { emitHarness } from '@iss/host/writer/harness';
import { emitRouterBody } from '@iss/host/writer/routerfile';
import { parseProject } from '@iss/host/parser/index';
import { augmentWithModel } from '@iss/host/project/augment';
import { simulate } from '@iss/host/project/run';

const ENGINE = path.resolve(__dirname, '..', '..', 'engine');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-fabric-'));

function buildModel(intents: EditIntent[]): AuthoringModel {
  return intents.reduce(applyIntent, EMPTY_MODEL);
}

/** LEGACY fixture: A (top leaf) --Ping--> B (top leaf), routers R0—R1.
 *  Cross-top wires can no longer be authored through the reducer (hard
 *  cutover), so the wire is hand-set on the model — simulating a legacy
 *  sidecar or hand-written configureOut. Every consumer asserts the ERROR
 *  path; rule-based transport lives in ruleFabricModel(). */
function fabricModel(): AuthoringModel {
  const m = buildModel([
    { kind: 'addComponent', id: 'A' },
    { kind: 'addComponent', id: 'B' },
    { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
    { kind: 'addComponent', id: 'R1', nodeKind: 'router' },
    { kind: 'addEvent', id: 'Ping', fields: [] },
    { kind: 'addWire', from: 'A', port: 'out', message: 'Ping', latency: 1 },
    { kind: 'setConsumes', id: 'B', consumes: ['Ping'] },
    { kind: 'attachRouter', id: 'A', router: 'R0', attach: true },
    { kind: 'attachRouter', id: 'B', router: 'R1', attach: true },
    { kind: 'linkRouters', a: 'R0', b: 'R1', connect: true },
  ]);
  m.components.find((c) => c.id === 'A')!.outPorts[0].to = 'B';
  return m;
}

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

describe('e2e: fabric transport', () => {
  it(
    'packets ride A → R0 → R1 → B with per-router latency',
    { timeout: 120_000 },
    async () => {
      const root = tmp();
      const model = ruleFabricModel();
      writeModel(root, model);
      writeHarness(root, model, {
        entries: [{ block: 'A', event: null }],
        tokens: 3,
        cycles: 32,
        wavesEnabled: false,
        checkDivergence: false,
      });
      const graph = augmentWithModel(parseProject([root]), model);
      const trace = await simulate(
        { projectRoot: root, enginePath: ENGINE, refModel: 'stub', log: () => {} },
        graph,
      );

      for (const token of [0, 1, 2]) {
        const chain = trace.hops
          .filter((h) => h.token === token)
          .sort((a, b) => a.depart - b.depart);
        expect(chain.map((h) => `${h.from}→${h.to}`)).toEqual(['A→R0', 'R0→R1', 'R1→B']);
        // wire latency 1 + one cycle per router hop.
        expect(chain[2].arrive - chain[0].depart).toBe(3);
      }
    },
  );

  it(
    'a hand-written latency model drives the hop latency',
    { timeout: 120_000 },
    async () => {
      const root = tmp();
      let model = buildModel([
        { kind: 'addComponent', id: 'A' },
        { kind: 'addComponent', id: 'B' },
        { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
        { kind: 'addEvent', id: 'Ping', fields: [] },
        { kind: 'addWire', from: 'A', port: 'out', message: 'Ping' },
        { kind: 'setConsumes', id: 'B', consumes: ['Ping'] },
        { kind: 'attachRouter', id: 'A', router: 'R0', attach: true },
        { kind: 'attachRouter', id: 'B', router: 'R0', attach: true },
      ]);
      writeModel(root, model);

      // The user's custom model, written into R0's hand-owned tail.
      const r0File = path.join(root, 'src', 'R0.cpp');
      fs.writeFileSync(
        r0File,
        fs.readFileSync(r0File, 'utf8').replace(
          '};',
          '    microarch::Cycle slow(const microarch::Event&) const { return 5; }\n};',
        ),
      );

      model = applyIntent(model, {
        kind: 'addForwardingRule',
        router: 'R0',
        rule: { message: 'Ping', to: 'B', latencyModel: 'slow' },
      });
      writeHarness(root, model, {
        entries: [{ block: 'A', event: null }],
        tokens: 2,
        cycles: 32,
        wavesEnabled: false,
        checkDivergence: false,
      });
      const graph = augmentWithModel(parseProject([root]), model);
      const trace = await simulate(
        { projectRoot: root, enginePath: ENGINE, refModel: 'stub', log: () => {} },
        graph,
      );

      // Packets reach R0 at cycles 1 and 2; the model makes each forward take
      // 5 cycles instead of the flat 1 → arrivals at B are 6 and 7.
      const arrivals = trace.hops
        .filter((h) => h.from === 'R0' && h.to === 'B')
        .map((h) => h.arrive)
        .sort((a, b) => a - b);
      expect(arrivals).toEqual([6, 7]);
    },
  );

  it(
    'same-cycle contenders through one router serialize one cycle apart',
    { timeout: 120_000 },
    async () => {
      const root = tmp();
      // S1 and S2 both fire into B through the single router R0.
      const model = buildModel([
        { kind: 'addComponent', id: 'S1' },
        { kind: 'addComponent', id: 'S2' },
        { kind: 'addComponent', id: 'B' },
        { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
        { kind: 'addEvent', id: 'Ping', fields: [] },
        { kind: 'addWire', from: 'S1', port: 'out', message: 'Ping' },
        { kind: 'addWire', from: 'S2', port: 'out', message: 'Ping' },
        { kind: 'setConsumes', id: 'B', consumes: ['Ping'] },
        { kind: 'attachRouter', id: 'S1', router: 'R0', attach: true },
        { kind: 'attachRouter', id: 'S2', router: 'R0', attach: true },
        { kind: 'attachRouter', id: 'B', router: 'R0', attach: true },
        { kind: 'addForwardingRule', router: 'R0', rule: { message: 'Ping', to: 'B' } },
      ]);
      writeModel(root, model);
      writeHarness(root, model, {
        entries: [
          { block: 'S1', event: null },
          { block: 'S2', event: null },
        ],
        tokens: 1,
        cycles: 32,
        wavesEnabled: false,
        checkDivergence: false,
      });
      const graph = augmentWithModel(parseProject([root]), model);
      const trace = await simulate(
        { projectRoot: root, enginePath: ENGINE, refModel: 'stub', log: () => {} },
        graph,
      );

      // Both packets reach R0 the same cycle; the router forwards one per
      // tick, so the two R0→B arrivals are exactly one cycle apart.
      const arrivals = trace.hops
        .filter((h) => h.from === 'R0' && h.to === 'B')
        .map((h) => h.arrive)
        .sort((a, b) => a - b);
      expect(arrivals).toHaveLength(2);
      expect(arrivals[1] - arrivals[0]).toBe(1);
    },
  );

  it(
    'weighted arbitration shares a contended port 2:1 and emits queue metrics',
    { timeout: 120_000 },
    async () => {
      const root = tmp();
      let model = buildModel([
        { kind: 'addComponent', id: 'S1' },
        { kind: 'addComponent', id: 'S2' },
        { kind: 'addComponent', id: 'B' },
        { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
        { kind: 'addEvent', id: 'Ping', fields: [] },
        { kind: 'addWire', from: 'S1', port: 'out', message: 'Ping' },
        { kind: 'addWire', from: 'S2', port: 'out', message: 'Ping' },
        { kind: 'setConsumes', id: 'B', consumes: ['Ping'] },
        { kind: 'attachRouter', id: 'S1', router: 'R0', attach: true },
        { kind: 'attachRouter', id: 'S2', router: 'R0', attach: true },
        { kind: 'attachRouter', id: 'B', router: 'R0', attach: true },
        { kind: 'addForwardingRule', router: 'R0', rule: { message: 'Ping', to: 'B' } },
      ]);
      model = applyIntent(model, { kind: 'setRouterArbitration', id: 'R0', policy: 'weighted' });
      model = applyIntent(model, {
        kind: 'setAttachmentPolicy',
        router: 'R0',
        component: 'S1',
        weight: 2,
      });
      model = applyIntent(model, { kind: 'setRouterQueue', id: 'R0', capacity: 8 });
      writeModel(root, model);
      writeHarness(root, model, {
        entries: [
          { block: 'S1', event: null },
          { block: 'S2', event: null },
        ],
        tokens: 3,
        cycles: 32,
        wavesEnabled: false,
        checkDivergence: false,
      });
      const graph = augmentWithModel(parseProject([root]), model);
      const trace = await simulate(
        { projectRoot: root, enginePath: ENGINE, refModel: 'stub', log: () => {} },
        graph,
      );

      // Map each token to its origin via its first hop, then read the origin
      // sequence off the R0→B forwards in depart order: deficit round-robin
      // with S1 weight 2 drains the backlog S1,S1,S2,S1,S2,S2.
      const originOf = new Map<number, string>();
      for (const h of trace.hops) if (h.to === 'R0') originOf.set(h.token, h.from);
      const sequence = trace.hops
        .filter((h) => h.from === 'R0' && h.to === 'B')
        .sort((a, b) => a.depart - b.depart)
        .map((h) => originOf.get(h.token));
      expect(sequence).toEqual(['S1', 'S1', 'S2', 'S1', 'S2', 'S2']);

      // Engine metric records ride the same trace into the IDE: the contended
      // port reports its queue depth (ground truth, change-only) and flow.
      const qdepth = (trace.metrics ?? []).filter(
        (m) => m.metric === 'qdepth' && m.component === 'R0',
      );
      expect(qdepth.length).toBeGreaterThan(0);
      expect(Math.max(...qdepth.map((m) => m.value))).toBeGreaterThan(0);
      expect((trace.metrics ?? []).some((m) => m.metric === 'flow')).toBe(true);
    },
  );

  it(
    'address-split rules route one generator to two memories; a range gap drops + reports',
    { timeout: 120_000 },
    async () => {
      // Gen1 emits sequential addresses 0xff8..0x1007 (16 packets); R0's
      // rules split them at 0x1000 between MemA and MemB across a trunk.
      const base: EditIntent[] = [
        { kind: 'addComponent', id: 'Gen1', role: 'trafficgen' },
        { kind: 'addComponent', id: 'MemA' },
        { kind: 'addComponent', id: 'MemB' },
        { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
        { kind: 'addComponent', id: 'R1', nodeKind: 'router' },
        { kind: 'addEvent', id: 'Req', fields: [] },
        { kind: 'addWire', from: 'Gen1', port: 'out', message: 'Req' },
        { kind: 'setConsumes', id: 'MemA', consumes: ['Req'] },
        { kind: 'setConsumes', id: 'MemB', consumes: ['Req'] },
        { kind: 'attachRouter', id: 'Gen1', router: 'R0', attach: true },
        { kind: 'attachRouter', id: 'MemA', router: 'R1', attach: true },
        { kind: 'attachRouter', id: 'MemB', router: 'R1', attach: true },
        { kind: 'linkRouters', a: 'R0', b: 'R1', connect: true },
        {
          kind: 'setTraffic',
          id: 'Gen1',
          traffic: {
            period: 1,
            burst: 1,
            count: 16,
            start: 0,
            pattern: 'fixed',
            addrLo: '0xff8',
            addrHi: '0x1007',
            addrPattern: 'sequential',
          },
        },
        {
          kind: 'addForwardingRule',
          router: 'R0',
          rule: { message: 'Req', addrLo: '0x0', addrHi: '0xfff', to: 'MemA' },
        },
        {
          kind: 'addForwardingRule',
          router: 'R0',
          rule: { message: 'Req', addrLo: '0x1000', addrHi: '0x1fff', to: 'MemB' },
        },
      ];
      const run = async (intents: EditIntent[]) => {
        const root = tmp();
        const model = buildModel(intents);
        writeModel(root, model);
        writeHarness(root, model, {
          entries: [],
          tokens: 8,
          cycles: 48,
          wavesEnabled: false,
          checkDivergence: false,
        });
        const graph = augmentWithModel(parseProject([root]), model);
        return simulate(
          { projectRoot: root, enginePath: ENGINE, refModel: 'stub', log: () => {} },
          graph,
        );
      };

      const trace = await run(base);
      const toMemA = trace.hops.filter((h) => h.from === 'R1' && h.to === 'MemA');
      const toMemB = trace.hops.filter((h) => h.from === 'R1' && h.to === 'MemB');
      expect(toMemA).toHaveLength(8); // 0xff8..0xfff
      expect(toMemB).toHaveLength(8); // 0x1000..0x1007
      expect(trace.divergences).toHaveLength(0);
      // Hops carry the address as hex for the TRACE tab.
      expect(toMemB.every((h) => h.addr !== undefined && BigInt(h.addr) >= 0x1000n)).toBe(true);

      // Gap run: without the MemB rule the upper half is unmatched — dropped
      // at R0 with a report, while the sim completes and MemA still fills.
      const gapped = await run([
        ...base.filter(
          (i) => !(i.kind === 'addForwardingRule' && i.rule.to === 'MemB'),
        ),
      ]);
      expect(gapped.hops.filter((h) => h.to === 'MemA')).toHaveLength(8);
      expect(gapped.hops.some((h) => h.to === 'MemB')).toBe(false);
      const drops = gapped.divergences.filter((d) => d.provenance === 'drop');
      expect(drops).toHaveLength(8);
      expect(drops[0].component).toBe('R0');
      expect(drops[0].detail).toContain('no forwarding rule matched');
      expect(drops[0].detail).toContain('type=Req');
      expect(gapped.ranCycles ?? 0).toBeGreaterThan(0);
    },
  );
});

/** Rule-based fixture: A's dangling Ping port enters R0; R0 rule sends Ping
 *  to B (attached at R1 over one trunk). No cross-top wires anywhere. */
function ruleFabricModel(): AuthoringModel {
  return buildModel([
    { kind: 'addComponent', id: 'A' },
    { kind: 'addComponent', id: 'B' },
    { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
    { kind: 'addComponent', id: 'R1', nodeKind: 'router' },
    { kind: 'addEvent', id: 'Ping', fields: [] },
    { kind: 'addWire', from: 'A', port: 'out', message: 'Ping' },
    { kind: 'setConsumes', id: 'B', consumes: ['Ping'] },
    { kind: 'attachRouter', id: 'A', router: 'R0', attach: true },
    { kind: 'attachRouter', id: 'B', router: 'R1', attach: true },
    { kind: 'linkRouters', a: 'R0', b: 'R1', connect: true },
    { kind: 'addForwardingRule', router: 'R0', rule: { message: 'Ping', to: 'B' } },
  ]);
}

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
