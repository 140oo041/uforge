// Top-level router fabric — the END-TO-END proof. These compile a generated
// design against ../engine and read the engine's own JSONL trace back, so they
// are the only tests here that can catch a disagreement between what the host
// generates and what the engine actually does.
//
// The most valuable tests in the repo, and the slowest. Derivation lives in
// fabric.test.ts, codegen in router-codegen.test.ts.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import type { EditIntent } from '@iss/contracts/model';
import { applyIntent } from '@iss/host/writer/edits';
import { writeHarness, writeModel } from '@iss/host/writer/index';
import { parseProject } from '@iss/host/parser/index';
import { augmentWithModel } from '@iss/host/project/augment';
import { simulate } from '@iss/host/project/run';
import { ENGINE, buildModel, ruleFabricModel, tmp } from './helpers/fabric';

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
