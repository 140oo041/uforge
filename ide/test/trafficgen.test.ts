// Traffic generators: intents, both codegen modes (generated ↔ detached
// hand-owned tail), parser round-trip (a gen is an ordinary leaf with Tier-1
// wires), augment overlay, harness shape (scheduler-first ctor, addClocked,
// no seeding), and a real-engine e2e generating at the configured cadence.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_TRAFFIC,
  EMPTY_MODEL,
  type AuthoringModel,
  type EditIntent,
} from '@iss/contracts/model';
import { applyIntent } from '@iss/host/writer/edits';
import { writeHarness, writeModel } from '@iss/host/writer/index';
import { emitHarness } from '@iss/host/writer/harness';
import { emitTrafficGenBody } from '@iss/host/writer/trafficfile';
import { END_MARKER } from '@iss/host/writer/markers';
import { parseProject } from '@iss/host/parser/index';
import { augmentWithModel } from '@iss/host/project/augment';
import { simulate } from '@iss/host/project/run';

const ENGINE = path.resolve(__dirname, '..', '..', 'engine');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-traffic-'));

function buildModel(intents: EditIntent[]): AuthoringModel {
  return intents.reduce(applyIntent, EMPTY_MODEL);
}

/** Sys.Gen1 --Req--> Sys.B (+ Sys.C) — wires stay inside one top-level unit
 *  (cross-top wires are not allowed; fabric traffic is rule-authored). */
function genModel(twoPorts = false): AuthoringModel {
  const intents: EditIntent[] = [
    { kind: 'addComponent', id: 'Sys', nodeKind: 'composite' },
    { kind: 'addComponent', id: 'Sys.Gen1', role: 'trafficgen' },
    { kind: 'addComponent', id: 'Sys.B' },
    { kind: 'addEvent', id: 'Req', fields: [{ name: 'addr', type: 'uint32_t' }] },
    { kind: 'addWire', from: 'Sys.Gen1', port: 'out', message: 'Req', to: 'Sys.B', latency: 1 },
  ];
  if (twoPorts) {
    intents.push({ kind: 'addComponent', id: 'Sys.C' });
    intents.push({ kind: 'addWire', from: 'Sys.Gen1', port: 'aux', message: 'Req', to: 'Sys.C', latency: 1 });
  }
  return buildModel(intents);
}

describe('traffic-gen intents', () => {
  it('addComponent role seeds default params; leaf-only', () => {
    const m = genModel();
    const gen = m.components.find((c) => c.id === 'Sys.Gen1')!;
    expect(gen.role).toBe('trafficgen');
    expect(gen.traffic).toEqual(DEFAULT_TRAFFIC);
    expect(() =>
      applyIntent(m, { kind: 'addComponent', id: 'G2', nodeKind: 'composite', role: 'trafficgen' }),
    ).toThrow(/plain leaf/);
    expect(() =>
      applyIntent(m, { kind: 'addComponent', id: 'G3', io: 'in', role: 'trafficgen' }),
    ).toThrow(/plain leaf/);
  });

  it('setTraffic validates; setTrafficMode toggles; gens refuse SV impl', () => {
    let m = genModel();
    m = applyIntent(m, {
      kind: 'setTraffic',
      id: 'Sys.Gen1',
      traffic: { period: 2, burst: 3, count: 10, start: 1, pattern: 'random' },
    });
    const gen = () => m.components.find((c) => c.id === 'Sys.Gen1')!;
    expect(gen().traffic).toEqual({ period: 2, burst: 3, count: 10, start: 1, pattern: 'random' });
    expect(() =>
      applyIntent(m, {
        kind: 'setTraffic',
        id: 'Sys.Gen1',
        traffic: { period: 0, burst: 1, count: 0, start: 0, pattern: 'fixed' },
      }),
    ).toThrow(/period/);
    expect(() =>
      applyIntent(m, { kind: 'setTraffic', id: 'Sys.B', traffic: DEFAULT_TRAFFIC }),
    ).toThrow(/not a traffic generator/);

    m = applyIntent(m, { kind: 'setTrafficMode', id: 'Sys.Gen1', mode: 'custom' });
    expect(gen().trafficMode).toBe('custom');
    m = applyIntent(m, { kind: 'setTrafficMode', id: 'Sys.Gen1', mode: 'generated' });
    expect(gen().trafficMode).toBeUndefined();

    expect(() => applyIntent(m, { kind: 'setImpl', id: 'Sys.Gen1', impl: 'sv' })).toThrow(/SV twin/);
  });
});

describe('traffic-gen codegen', () => {
  it('generated body: scheduler-first ctor, guards, minted tokens, patterns', () => {
    let m = genModel(true);
    m = applyIntent(m, {
      kind: 'setTraffic',
      id: 'Sys.Gen1',
      traffic: { period: 4, burst: 2, count: 9, start: 3, pattern: 'roundrobin' },
    });
    const body = emitTrafficGenBody(m.components.find((c) => c.id === 'Sys.Gen1')!, m);

    expect(body).toContain('class Gen1 : public Component {');
    expect(body).toContain(
      'explicit Gen1(microarch::Scheduler& scheduler, Link* out = nullptr, Link* aux = nullptr)',
    );
    expect(body).toContain('void tick(microarch::Cycle cycle) override {');
    expect(body).toContain('if (cycle < 3) return;');
    expect(body).toContain('if (sent_ >= 9) return;');
    expect(body).toContain('if ((cycle - 3) % 4 != 0) return;');
    expect(body).toContain('for (uint64_t b = 0; b < 2; ++b) {');
    expect(body).toContain('const uint64_t pick = rr_++ % 2;');
    expect(body).toContain('ev_out->token = scheduler_.mintToken();');
    expect(body).toContain('out->configureOut(registry.find("Sys.B"));');
    expect(body).toContain('aux->configureOut(registry.find("Sys.C"));');
    // The handler never auto-emits — origination is tick()-only.
    expect(body).toContain('void handler(Event& ev) override {\n        (void)ev;\n    }');
  });

  it('fixed and random patterns emit their pick logic', () => {
    let m = genModel();
    m = applyIntent(m, {
      kind: 'setTraffic',
      id: 'Sys.Gen1',
      traffic: { ...DEFAULT_TRAFFIC, pattern: 'fixed' },
    });
    expect(emitTrafficGenBody(m.components.find((c) => c.id === 'Sys.Gen1')!, m)).toContain(
      'const uint64_t pick = 0;',
    );
    m = applyIntent(m, {
      kind: 'setTraffic',
      id: 'Sys.Gen1',
      traffic: { ...DEFAULT_TRAFFIC, pattern: 'random' },
    });
    expect(emitTrafficGenBody(m.components.find((c) => c.id === 'Sys.Gen1')!, m)).toContain(
      'lfsr_ ^= lfsr_ << 13;',
    );
  });
});

describe('traffic-gen file modes', () => {
  it('generated → detach seeds the tail; hand edits survive; re-attach overwrites', () => {
    const root = tmp();
    let m = genModel();
    writeModel(root, m);
    const file = path.join(root, 'src', 'Sys', 'Gen1.cpp');
    const generated = fs.readFileSync(file, 'utf8');
    // Generated mode: whole class inside the markers, nothing after END.
    expect(generated.slice(generated.indexOf(END_MARKER) + END_MARKER.length).trim()).toBe('');
    // Self-contained prologue: the unqualified-name shims and the Scheduler.
    // A gen may be the FIRST leaf the harness includes (ids sort), so it
    // cannot lean on another block's includes.
    expect(generated).toContain('#include "infra/component.h"');
    expect(generated).toContain('#include "infra/link.h"');
    expect(generated).toContain('#include "microarch/scheduler.hpp"');
    expect(generated).toContain('void tick(microarch::Cycle cycle) override {');
    expect(generated).not.toContain('.sv'); // and no SV twin on disk:
    expect(fs.existsSync(path.join(root, 'src', 'Sys', 'Gen1.sv'))).toBe(false);

    // Detach: tail below END seeded with the current generated tick().
    m = applyIntent(m, { kind: 'setTrafficMode', id: 'Sys.Gen1', mode: 'custom' });
    writeModel(root, m);
    const detached = fs.readFileSync(file, 'utf8');
    const tail = detached.slice(detached.indexOf(END_MARKER) + END_MARKER.length);
    expect(tail).toContain('void tick(microarch::Cycle cycle) override {');
    expect(tail).toContain('Hand-owned generation logic');
    // The head (inside markers) no longer holds tick().
    expect(detached.slice(0, detached.indexOf(END_MARKER))).not.toContain('void tick(');

    // Hand-edit the tail; unrelated model edits must preserve it byte-for-byte.
    const edited = detached.replace('for (uint64_t b = 0;', 'for (uint64_t b = 0; /* mine */');
    fs.writeFileSync(file, edited);
    m = applyIntent(m, { kind: 'addComponent', id: 'Other' });
    writeModel(root, m);
    const afterEdit = fs.readFileSync(file, 'utf8');
    expect(afterEdit.slice(afterEdit.indexOf(END_MARKER))).toBe(
      edited.slice(edited.indexOf(END_MARKER)),
    );

    // Param edits while detached don't touch the tail either.
    m = applyIntent(m, {
      kind: 'setTraffic',
      id: 'Sys.Gen1',
      traffic: { ...DEFAULT_TRAFFIC, period: 9 },
    });
    writeModel(root, m);
    expect(fs.readFileSync(file, 'utf8')).toContain('/* mine */');

    // Re-attach: the confirmed destructive rewrite regenerates from params.
    m = applyIntent(m, { kind: 'setTrafficMode', id: 'Sys.Gen1', mode: 'generated' });
    writeModel(root, m);
    const reattached = fs.readFileSync(file, 'utf8');
    expect(reattached).not.toContain('/* mine */');
    expect(reattached).toContain('% 9 != 0) return;'); // the period edit took effect
    expect(reattached.slice(reattached.indexOf(END_MARKER) + END_MARKER.length).trim()).toBe('');
  });

  it('round-trips: parses as a leaf with Tier-1 wires; augment overlays role', () => {
    const root = tmp();
    let m = genModel(true);
    m = applyIntent(m, {
      kind: 'setTraffic',
      id: 'Sys.Gen1',
      traffic: { period: 2, burst: 2, count: 0, start: 0, pattern: 'roundrobin' },
    });
    writeModel(root, m);

    const graph = augmentWithModel(parseProject([root]), m);
    const gen = graph.components.find((c) => c.id === 'Sys.Gen1')!;
    expect(gen.kind).toBe('leaf');
    expect(gen.role).toBe('trafficgen');
    expect(gen.traffic).toEqual({ period: 2, burst: 2, count: 0, start: 0, pattern: 'roundrobin' });
    expect(gen.trafficMode).toBeUndefined();
    expect(gen.outPorts.map((p) => p.name).sort()).toEqual(['aux', 'out']);

    const wires = graph.links.filter((l) => l.from === 'Sys.Gen1');
    expect(wires).toHaveLength(2);
    for (const w of wires) expect(w.status).toBe('wired');
    expect(wires.map((w) => w.to).sort()).toEqual(['Sys.B', 'Sys.C']);
  });
});

describe('traffic-gen harness', () => {
  it('scheduler-first instantiation, addClocked, and no seeding', () => {
    const m = genModel();
    const text = emitHarness(m, { tokens: 4, cycles: 32 });
    expect(text).toContain('Sys::Gen1 s_Sys_Gen1(scheduler, &link_Sys_Gen1_out);');
    expect(text).toContain('scheduler.addClocked(s_Sys_Gen1);');
    // Two ports pin the positional contract: scheduler first, links in
    // authored order after it.
    expect(emitHarness(genModel(true))).toContain(
      'Sys::Gen1 s_Sys_Gen1(scheduler, &link_Sys_Gen1_out, &link_Sys_Gen1_aux);',
    );
    // The gen is the only entry candidate — nothing is seeded.
    expect(text).not.toContain('scheduler.seed(');
    // Manual run-config entries at a gen are skipped, loudly.
    const manual = emitHarness(m, { entries: [{ block: 'Sys.Gen1', event: 'Req' }], tokens: 4 });
    expect(manual).toContain("run-config entry 'Sys.Gen1' is a traffic generator");
    expect(manual).not.toContain('scheduler.seed(');
  });
});

describe('e2e: traffic generation', () => {
  it(
    'a gen drives distinct tokens through a router at its configured cadence',
    { timeout: 120_000 },
    async () => {
      const root = tmp();
      // 'Gen1' < 'Sink1': the gen is the FIRST leaf the harness includes, so
      // this also proves the generated file compiles standalone (its own
      // prologue must supply the Component/Link/Event shims).
      let model = buildModel([
        { kind: 'addComponent', id: 'Gen1', role: 'trafficgen' },
        { kind: 'addComponent', id: 'Sink1' },
        { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
        { kind: 'addEvent', id: 'Req', fields: [] },
        { kind: 'addWire', from: 'Gen1', port: 'out', message: 'Req' },
        { kind: 'setConsumes', id: 'Sink1', consumes: ['Req'] },
        { kind: 'attachRouter', id: 'Gen1', router: 'R0', attach: true },
        { kind: 'attachRouter', id: 'Sink1', router: 'R0', attach: true },
        { kind: 'addForwardingRule', router: 'R0', rule: { message: 'Req', to: 'Sink1' } },
      ]);
      model = applyIntent(model, {
        kind: 'setTraffic',
        id: 'Gen1',
        traffic: { period: 2, burst: 1, count: 3, start: 0, pattern: 'fixed' },
      });
      writeModel(root, model);
      writeHarness(root, model, {
        entries: [],
        tokens: 8,
        cycles: 32,
        wavesEnabled: false,
        checkDivergence: false,
      });
      const graph = augmentWithModel(parseProject([root]), model);
      const trace = await simulate(
        { projectRoot: root, enginePath: ENGINE, refModel: 'stub', log: () => {} },
        graph,
      );

      // Three packets at ticks 0, 2, 4 (period 2, count 3), each a distinct
      // token, each riding Gen1 → R0 → Sink1.
      const origins = trace.hops.filter((h) => h.from === 'Gen1' && h.to === 'R0');
      expect(origins.map((h) => h.depart)).toEqual([0, 2, 4]);
      expect(new Set(origins.map((h) => h.token)).size).toBe(3);
      for (const token of origins.map((h) => h.token)) {
        const chain = trace.hops
          .filter((h) => h.token === token)
          .sort((a, b) => a.depart - b.depart);
        expect(chain.map((h) => `${h.from}→${h.to}`)).toEqual(['Gen1→R0', 'R0→Sink1']);
      }
    },
  );
});
