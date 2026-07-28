// @vitest-environment happy-dom
// Webview smoke test: the ONE canvas app renders the real parsed graph —
// hierarchy levels, nodes with vars, wires (with status classes), palette,
// inspector, dock, spec designer — and reacts to selection/trace messages.
// Guards against v1's fatal seam (a shipped webview that ignored the graph
// protocol).

import { describe, expect, it } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CanvasApp, windowMessageTransport } from '@iss/canvas';
import { parseProject } from '@iss/host/parser/index';
import { writeModel } from '@iss/host/writer/index';
import { applyIntent } from '@iss/host/writer/edits';
import { augmentWithModel } from '@iss/host/project/augment';
import { levelEdges, visibleComponents } from '@iss/canvas/layout';
import { synthesizeTrace } from '@iss/host/trace/synthesize';
import { EMPTY_MODEL, type EditIntent } from '@iss/contracts/model';
import { TEMPLATE_GPU, TEMPLATE_RV32I } from '@iss/contracts/spec';
import type { HostMsg } from '@iss/contracts/messaging';

// A canonical fixture project (same shape gen-sample produces), generated
// into a tmp dir — the real sample/ is user-editable and must not gate tests.
const FIXTURE: EditIntent[] = [
  { kind: 'addComponent', id: 'CPU0', label: 'Core 0', nodeKind: 'composite' },
  { kind: 'addComponent', id: 'CPU0.IF', label: 'Instruction Fetch' },
  { kind: 'addComponent', id: 'CPU0.DE', label: 'Decode' },
  { kind: 'addComponent', id: 'CPU0.EX', label: 'Execute' },
  { kind: 'addComponent', id: 'CPU0.MEM', label: 'Memory Access' },
  { kind: 'addComponent', id: 'CPU0.WB', label: 'Writeback' },
  { kind: 'addComponent', id: 'CPU0.Control', label: 'Hazard Control' },
  { kind: 'addComponent', id: 'Memory1', label: 'Main Memory' },
  { kind: 'addEvent', id: 'FetchEvent', fields: [{ name: 'pc', type: 'uint32_t' }] },
  { kind: 'addEvent', id: 'DecodeEvent', fields: [] },
  { kind: 'addEvent', id: 'ExecEvent', fields: [] },
  { kind: 'addEvent', id: 'MemRequest', fields: [] },
  { kind: 'addEvent', id: 'MemEvent', fields: [] },
  { kind: 'addEvent', id: 'BranchEvent', fields: [] },
  { kind: 'addEvent', id: 'StallEvent', fields: [] },
  { kind: 'addWire', from: 'CPU0.IF', port: 'out', message: 'FetchEvent', to: 'CPU0.DE', latency: 1 },
  { kind: 'addWire', from: 'CPU0.DE', port: 'out', message: 'DecodeEvent', to: 'CPU0.EX', latency: 1 },
  { kind: 'addWire', from: 'CPU0.EX', port: 'out', message: 'ExecEvent', to: 'CPU0.MEM', latency: 1 },
  { kind: 'addWire', from: 'CPU0.EX', port: 'branch', message: 'BranchEvent', to: 'CPU0.Control', latency: 0 },
  { kind: 'addWire', from: 'CPU0.MEM', port: 'out', message: 'MemEvent', to: 'CPU0.WB', latency: 1 },
  { kind: 'addWire', from: 'CPU0.Control', port: 'stall', message: 'StallEvent', to: 'CPU0.IF', latency: 1 },
  // Fabric-bound: cross-top wires are not allowed; the MEM port dangles and
  // Memory1 consumes MemRequest (rule-based tests attach a router + rule).
  { kind: 'addWire', from: 'CPU0.MEM', port: 'mem', message: 'MemRequest', latency: 2 },
  { kind: 'setConsumes', id: 'Memory1', consumes: ['MemRequest'] },
  { kind: 'setVars', id: 'CPU0.IF', vars: [{ name: 'pc', type: 'uint32_t', init: '0x80000000' }] },
  { kind: 'setVars', id: 'CPU0.EX', vars: [{ name: 'result', type: 'uint32_t', init: null }] },
  { kind: 'setVars', id: 'Memory1', vars: [{ name: 'accesses', type: 'uint64_t', init: '0' }] },
];

/** What the host actually posts: the parsed graph merged with model labels. */
function sampleGraph() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-webview-'));
  const model = FIXTURE.reduce(applyIntent, EMPTY_MODEL);
  writeModel(root, model);
  return augmentWithModel(parseProject([root]), model);
}

// The canvas is host-agnostic, so a test has to say who it is talking to. This
// is the same transport the extension's webview uses — messages arrive as
// window events — so these tests cover the real seam, not a stand-in for it.
// Outbound messages go nowhere, which is exactly what happens outside a host.
const TEST_TRANSPORT = windowMessageTransport(() => {});

function send(msg: HostMsg) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

describe('canvas webview', () => {
  it('renders the root level: composite + memory, aggregated wired edges', () => {
    const graph = sampleGraph();
    // All authored wires round-trip Tier-1; the fabric-bound MEM port (no
    // router yet) surfaces as a Tier-2 inferred suggestion toward Memory1.
    expect(
      graph.links.filter((l) => l.status === 'wired').length,
    ).toBe(graph.links.length - 1);
    expect(graph.links.find((l) => l.id === 'CPU0.MEM.mem')?.status).toBe('inferred');

    const { container } = render(<CanvasApp transport={TEST_TRANSPORT} />);
    send({ type: 'graph', graph });
    send({
      type: 'authored',
      components: graph.components.map((c) => c.id),
      events: graph.events.map((e) => e.id),
    });

    // Root level: only CPU0 (composite) and Memory1 are visible.
    const rootVisible = visibleComponents(graph, null);
    const nodes = container.querySelectorAll('.node');
    expect(nodes.length).toBe(rootVisible.length);
    expect(container.querySelectorAll('.node.composite').length).toBe(1);
    expect(container.textContent).toContain('Core 0');
    expect(container.textContent).toContain('Main Memory');

    // The dangling CPU0.MEM port has a unique consumer, so it surfaces as an
    // inferred (dashed) cross-boundary edge at the root — a suggestion, not
    // an authored wire.
    const rootEdges = levelEdges(graph, null);
    expect(container.querySelectorAll('.wire-wired').length).toBe(
      rootEdges.filter((e) => e.status === 'wired').length,
    );
    expect(container.querySelectorAll('.wire-inferred').length).toBe(
      rootEdges.filter((e) => e.status === 'inferred').length,
    );

    // Vars render on the Memory1 leaf node.
    const memory = [...nodes].find((n) => n.textContent?.includes('Main Memory'))!;
    expect(memory.querySelector('.var-row')?.textContent).toContain('accesses');

    // No design errors: the fixture has no authored cross-top wires.
    expect(container.querySelector('.wire-fabric-error')).toBeNull();

    // Composites offer a fresh-connection handle too (composite ⇄ composite
    // wiring resolves inner leaves in the connect form).
    const composite = container.querySelector('.node.composite')!;
    expect(composite.querySelector('.port-dot.new-port')).not.toBeNull();

    // Run log lines land in the console tab.
    send({ type: 'runlog', line: 'g++ compile OK' });
    expect(container.querySelector('.console')?.textContent).toContain('g++ compile OK');

    // Edit errors surface as a toast.
    send({ type: 'editError', message: "unknown component 'zzz'" });
    expect(container.querySelector('.toast')?.textContent).toContain('unknown component');
  });

  it('drills into the composite via host selection and shows the pipeline', () => {
    const graph = sampleGraph();
    const { container } = render(<CanvasApp transport={TEST_TRANSPORT} />);
    send({ type: 'graph', graph });
    send({
      type: 'authored',
      components: graph.components.map((c) => c.id),
      events: graph.events.map((e) => e.id),
    });

    // Host-driven selection of an inner block navigates to its level.
    send({ type: 'selection', id: 'CPU0.EX' });
    const inner = visibleComponents(graph, 'CPU0');
    expect(container.querySelectorAll('.node').length).toBe(inner.length);
    expect(container.textContent).toContain('Instruction Fetch');
    expect(container.querySelectorAll('.node.selected').length).toBe(1);

    // Breadcrumb shows the path (display label, not the raw id).
    expect(container.querySelector('.breadcrumb')?.textContent).toContain('Core 0');

    // In-port rows: every consumed event is listed by name on the consumer's
    // input side (e.g. FetchEvent on DE), so it reads on BOTH wire ends.
    const edges = levelEdges(graph, 'CPU0');
    for (const comp of inner) {
      const node = [...container.querySelectorAll('.node')].find((n) =>
        n.textContent?.includes(comp.label),
      )!;
      const inRows = node.querySelectorAll('.port-row.in-row');
      expect(inRows.length, comp.id).toBe(comp.consumes.length);
      for (const m of comp.consumes)
        expect([...inRows].some((r) => r.textContent?.includes(m)), `${comp.id} shows ${m}`).toBe(
          true,
        );
      // Wired in-rows get a lit dot; unwired blocks keep a default drop pin.
      const inbound = edges.filter((e) => e.to === comp.id).length;
      expect(node.querySelectorAll('.port-dot.in').length, comp.id).toBeGreaterThanOrEqual(
        Math.max(1, Math.min(inbound, comp.consumes.length)),
      );
    }

    // IF shows its pc variable.
    const ifNode = [...container.querySelectorAll('.node')].find((n) =>
      n.textContent?.includes('Instruction Fetch'),
    )!;
    expect(ifNode.querySelector('.var-row')?.textContent).toContain('pc');

    // The inspector shows the selected EX block with a Variables section and
    // a per-port wire delete affordance.
    expect(container.querySelector('.inspector')?.textContent).toContain('Variables');
    expect(
      container.querySelector('.inspector .insp-port button[title^="delete wire"]'),
    ).not.toBeNull();

    // Trace tokens work at the inner level too — the transport lives in the
    // bottom panel's TRACE tab; the status bar mirrors the cycle count.
    const trace = synthesizeTrace(graph, { tokens: 2 });
    expect(trace.hops.length).toBeGreaterThan(0);
    send({ type: 'trace', trace });
    const traceTab = [...container.querySelectorAll('.panel-tabs button')].find((b) =>
      b.textContent?.includes('TRACE'),
    )!;
    act(() => {
      (traceTab as HTMLButtonElement).click();
    });
    expect(container.querySelector('.cycle-badge')?.textContent).toContain(`/ ${trace.cycles}`);
    expect(container.querySelector('.status-bar')?.textContent).toContain(`/ ${trace.cycles}`);
  });

  it('SPEC tab renders templates, RV32I oracle badges, GPU spec-only, types/signals', () => {
    const graph = sampleGraph();
    const { container } = render(<CanvasApp transport={TEST_TRANSPORT} />);
    send({ type: 'graph', graph });

    // The SPEC is a real editor tab now (tab strip + activity bar).
    const specTabButton = [...container.querySelectorAll('.tab-bar .editor-tab')].find((b) =>
      b.textContent?.includes('SPEC'),
    )!;

    // No spec → template picker.
    send({ type: 'spec', spec: null });
    act(() => {
      (specTabButton as HTMLButtonElement).click();
    });
    expect(container.querySelector('.spec-tab')?.textContent).toContain('Start from a template');
    expect(container.querySelectorAll('.spec-template').length).toBeGreaterThanOrEqual(4);

    // RV32I spec: oracle badges + the word type + generated-state note.
    send({ type: 'spec', spec: TEMPLATE_RV32I });
    const rv = container.querySelector('.spec-tab')!;
    expect(rv.textContent).toContain('✓oracle');
    expect(rv.textContent).toContain('add');
    expect(rv.textContent).toContain('word');
    expect(rv.textContent).toContain('iss_arch.h');

    // GPU spec: spec-only ops, signal enum values as chips, no inspector.
    send({ type: 'spec', spec: TEMPLATE_GPU });
    const designer = container.querySelector('.spec-tab')!;
    expect(designer.textContent).toContain('v_add');
    expect(designer.textContent).toContain('spec-only');
    expect(designer.textContent).not.toContain('✓oracle');
    expect(designer.textContent).toContain('WaveState');
    expect([...designer.querySelectorAll('.spec-chip')].map((c) => c.textContent)).toContain(
      'READY✕',
    );
    expect(container.querySelector('.inspector')).toBeNull();

    // Canvas comes back when switching to the Design tab.
    const designTab = [...container.querySelectorAll('.tab-bar .editor-tab')].find((b) =>
      b.textContent?.includes('Design'),
    )!;
    act(() => {
      (designTab as HTMLButtonElement).click();
    });
    expect(container.querySelector('.canvas')).not.toBeNull();
    expect(container.querySelector('.status-bar')).not.toBeNull();
  });

  it('composite pins, entry badge, and run-config panel', () => {
    // Unit1 with an in-pin and out-pin; Feeder wires in from outside.
    const PIN_FIXTURE: EditIntent[] = [
      { kind: 'addComponent', id: 'Unit1', label: 'Accelerator', nodeKind: 'composite' },
      { kind: 'addComponent', id: 'Unit1.req', label: 'Request in', io: 'in' },
      { kind: 'addComponent', id: 'Unit1.Stage1' },
      { kind: 'addComponent', id: 'Unit1.resp', label: 'Response out', io: 'out' },
      { kind: 'addComponent', id: 'Feeder' },
      { kind: 'addEvent', id: 'ReqEvent' },
      { kind: 'addEvent', id: 'WorkEvent' },
      { kind: 'addEvent', id: 'RespEvent' },
      { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
      { kind: 'addWire', from: 'Feeder', port: 'out_Feeder', message: 'ReqEvent', latency: 1 },
      { kind: 'setConsumes', id: 'Unit1.req', consumes: ['ReqEvent'] },
      { kind: 'attachRouter', id: 'Feeder', router: 'R0', attach: true },
      { kind: 'attachRouter', id: 'Unit1', router: 'R0', attach: true },
      { kind: 'addForwardingRule', router: 'R0', rule: { message: 'ReqEvent', to: 'Unit1' } },
      { kind: 'addWire', from: 'Unit1.req', port: 'fwd', message: 'WorkEvent', to: 'Unit1.Stage1', latency: 0 },
      { kind: 'addWire', from: 'Unit1.Stage1', port: 'out', message: 'RespEvent', to: 'Unit1.resp', latency: 1 },
    ];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-webview-'));
    const model = PIN_FIXTURE.reduce(applyIntent, EMPTY_MODEL);
    writeModel(root, model);
    const graph = augmentWithModel(parseProject([root]), model);

    const { container } = render(<CanvasApp transport={TEST_TRANSPORT} />);
    send({ type: 'graph', graph });
    send({
      type: 'authored',
      components: graph.components.map((c) => c.id),
      events: graph.events.map((e) => e.id),
    });

    // The minimized composite lists its I/O pins as boundary rows, with the
    // event each carries.
    const unit = [...container.querySelectorAll('.node.composite')].find((n) =>
      n.textContent?.includes('Accelerator'),
    )!;
    const pinRows = unit.querySelectorAll('.port-row.pin-row');
    expect(pinRows.length).toBe(2);
    expect(pinRows[0].textContent).toContain('Request in');
    expect(pinRows[0].textContent).toContain('WorkEvent');
    expect(pinRows[1].textContent).toContain('Response out');
    expect(pinRows[1].textContent).toContain('RespEvent');

    // Auto entry detection badges Feeder (the only untargeted leaf).
    const feeder = [...container.querySelectorAll('.node')].find((n) =>
      n.textContent?.includes('Feeder'),
    )!;
    expect(feeder.querySelector('.entry-badge')).not.toBeNull();
    expect(unit.querySelector('.entry-badge')).toBeNull();

    // The run-config popover opens from the tab bar and shows tokens/cycles.
    send({
      type: 'runConfig',
      config: { entries: [], tokens: 8, cycles: 64, wavesEnabled: true, checkDivergence: false },
    });
    const cfgButton = [...container.querySelectorAll<HTMLButtonElement>('.tab-actions button')].find(
      (b) => b.title.includes('Run configuration'),
    )!;
    act(() => {
      (cfgButton as HTMLButtonElement).click();
    });
    const panel = container.querySelector('.run-config')!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('Entry blocks');
    expect(panel.textContent).toContain('Feeder'); // auto-detected list
    expect(panel.querySelectorAll('input[type="number"]').length).toBe(2);
  });

  it('pipeline tab, event-field dropdowns, SV chip, congestion', () => {
    const graph = sampleGraph();
    const { container } = render(<CanvasApp transport={TEST_TRANSPORT} />);
    send({ type: 'graph', graph });
    send({
      type: 'authored',
      components: graph.components.map((c) => c.id),
      events: graph.events.map((e) => e.id),
    });
    send({ type: 'selection', id: 'CPU0.EX' }); // drill into CPU0

    // Event-field dropdown: FetchEvent has fields; a ▾ chevron on IF's
    // out-row opens the card listing them (same event shows on DE's in-row).
    const ifNode = [...container.querySelectorAll('.node')].find((n) =>
      n.textContent?.includes('Instruction Fetch'),
    )!;
    const chevron = ifNode.querySelector('.port-row:not(.in-row) .field-chevron')!;
    expect(chevron).not.toBeNull();
    act(() => {
      (chevron as HTMLElement).click();
    });
    const card = container.querySelector('.field-card')!;
    expect(card.textContent).toContain('FetchEvent');
    expect(card.textContent).toContain('pc');
    const deNode = [...container.querySelectorAll('.node')].find((n) =>
      n.textContent?.includes('Decode'),
    )!;
    expect(deNode.querySelector('.port-row.in-row .field-chevron')).not.toBeNull();

    // Synthetic congested trace: 4 tokens all converging on CPU0.MEM.
    const hops = Array.from({ length: 4 }, (_, token) => ({
      token,
      from: 'CPU0.IF',
      to: 'CPU0.MEM',
      event: 'FetchEvent',
      depart: 0,
      arrive: 2,
    }));
    send({
      type: 'trace',
      trace: { hops, divergences: [], cycles: 6, source: 'run' as const },
    });
    const memNode = [...container.querySelectorAll('.node')].find((n) =>
      n.textContent?.includes('Memory Access'),
    )!;
    expect(memNode.className).toContain('congested');
    expect(memNode.querySelector('.occupancy-chip')?.textContent).toBe('×4');

    // PIPELINE tab: token × cycle grid with stage cells.
    const pipelineTab = [...container.querySelectorAll('.panel-tabs button')].find((b) =>
      b.textContent?.includes('PIPELINE'),
    )!;
    act(() => {
      (pipelineTab as HTMLButtonElement).click();
    });
    const grid = container.querySelector('.pipe-grid')!;
    expect(grid).not.toBeNull();
    expect(grid.querySelectorAll('tbody tr').length).toBe(4); // one row per token
    const cell = grid.querySelector('.pipe-cell')!;
    expect(cell.textContent).toContain('Memory Access'); // in-flight toward MEM
  });

  it('waves tab appears with wave docs, renders lanes and the playhead cursor', () => {
    const graph = sampleGraph();
    const { container } = render(<CanvasApp transport={TEST_TRANSPORT} />);
    send({ type: 'graph', graph });

    // No waves → no WAVES tab.
    expect(
      [...container.querySelectorAll('.panel-tabs button')].some((b) =>
        b.textContent?.includes('WAVES'),
      ),
    ).toBe(false);

    send({
      type: 'waves',
      waves: [
        {
          block: 'CPU0.IF',
          timescale: '1ps',
          maxTime: 7,
          signals: [
            {
              id: '!',
              name: 'IF.clk',
              width: 1,
              changes: [
                { t: 0, v: '1' },
                { t: 1, v: '0' },
                { t: 2, v: '1' },
              ],
            },
            {
              id: '#',
              name: 'IF.FetchEvent_pc',
              width: 32,
              changes: [{ t: 0, v: '10000000' }],
            },
          ],
        },
      ],
    });

    const wavesTab = [...container.querySelectorAll('.panel-tabs button')].find((b) =>
      b.textContent?.includes('WAVES'),
    )!;
    expect(wavesTab).not.toBeNull();
    act(() => {
      (wavesTab as HTMLButtonElement).click();
    });
    const waves = container.querySelector('.waves')!;
    expect(waves).not.toBeNull();
    expect(waves.textContent).toContain('CPU0.IF');
    expect(waves.textContent).toContain('IF.FetchEvent_pc');
    expect(waves.querySelectorAll('.waves-name').length).toBe(2);
    expect(waves.querySelector('.wave-bit')).not.toBeNull(); // clk step lane
    expect(waves.querySelector('.wave-vec')).not.toBeNull(); // vector value block
    expect(waves.querySelector('.wave-cursor')).not.toBeNull();

    // Clearing waves (e.g. all blocks back to C++) removes the tab again.
    send({ type: 'waves', waves: [] });
    expect(
      [...container.querySelectorAll('.panel-tabs button')].some((b) =>
        b.textContent?.includes('WAVES'),
      ),
    ).toBe(false);
  });

  it('METRICS tab and canvas heat overlay appear for run traces only', () => {
    const graph = sampleGraph();
    const { container } = render(<CanvasApp transport={TEST_TRANSPORT} />);
    send({ type: 'graph', graph });

    // Synthetic/no trace → no METRICS tab, no overlay toggle.
    expect(
      [...container.querySelectorAll('.panel-tabs button')].some((b) =>
        b.textContent?.includes('METRICS'),
      ),
    ).toBe(false);
    expect(container.querySelector('.metrics-toggle')).toBeNull();

    send({
      type: 'trace',
      trace: {
        hops: [
          { token: 0, from: 'CPU0.MEM', to: 'Memory1', event: 'MemRequest', depart: 0, arrive: 2 },
          { token: 1, from: 'CPU0.MEM', to: 'Memory1', event: 'MemRequest', depart: 0, arrive: 3 },
        ],
        divergences: [],
        metrics: [{ metric: 'qdepth', cycle: 0, component: 'Memory1', port: 'out', value: 2 }],
        cycles: 4,
        source: 'run',
      },
    });

    // The dock gains METRICS; its tables show the link and the queue sample.
    const metricsTab = [...container.querySelectorAll('.panel-tabs button')].find((b) =>
      b.textContent?.includes('METRICS'),
    )!;
    expect(metricsTab).not.toBeNull();
    act(() => {
      (metricsTab as HTMLButtonElement).click();
    });
    const tabBody = container.querySelector('.metrics-tab')!;
    expect(tabBody).not.toBeNull();
    expect(tabBody.textContent).toContain('Memory Access → Main Memory');
    expect(tabBody.textContent).toContain('Main Memory');
    expect(tabBody.querySelector('.metrics-hist')).not.toBeNull();

    // The canvas toggle lights the aggregated CPU0 → Memory1 edge and tints
    // the sampled node with its queue-depth chip.
    const toggle = container.querySelector('.metrics-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(container.querySelector('[class*="wire-heat-"]')).toBeNull();
    act(() => {
      toggle.click();
    });
    expect(container.querySelector('[class*="wire-heat-"]')).not.toBeNull();
    expect(container.querySelector('.wire-bw')).not.toBeNull();
    expect(container.querySelector('.depth-chip')!.textContent).toContain('2');
    act(() => {
      toggle.click();
    });
    expect(container.querySelector('[class*="wire-heat-"]')).toBeNull();
  });

  it('routers render fabric edges; rule-bound ports surface as routed links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-webview-fabric-'));
    const intents: EditIntent[] = [
      ...FIXTURE,
      { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
      { kind: 'attachRouter', id: 'CPU0', router: 'R0', attach: true },
      { kind: 'attachRouter', id: 'Memory1', router: 'R0', attach: true },
      // Cutover: the cross-top wire becomes a dangling fabric-bound port
      // plus a forwarding rule on the router.
      { kind: 'deleteWire', from: 'CPU0.MEM', port: 'mem' },
      { kind: 'addWire', from: 'CPU0.MEM', port: 'mem', message: 'MemRequest', latency: 2 },
      { kind: 'addForwardingRule', router: 'R0', rule: { message: 'MemRequest', to: 'Memory1' } },
    ];
    const model = intents.reduce(applyIntent, EMPTY_MODEL);
    writeModel(root, model);
    const graph = augmentWithModel(parseProject([root]), model);

    // Host-side truth first: the fabric-bound port is a routed link, the
    // rule derives a CPU0 → Memory1 ghost edge, and nothing errors.
    const routedLink = graph.links.find((l) => l.id === 'CPU0.MEM.mem')!;
    expect(routedLink.status).toBe('routed');
    expect(routedLink.to).toBeNull();
    expect(routedLink.via).toEqual(['R0']);
    expect(graph.derived).toEqual([
      { fromTop: 'CPU0', toTop: 'Memory1', router: 'R0', ruleIndex: 0, message: 'MemRequest' },
    ]);
    expect(graph.diagnostics ?? []).toEqual([]);
    expect(graph.components.find((c) => c.id === 'R0')!.rules).toHaveLength(1);

    const { container } = render(<CanvasApp transport={TEST_TRANSPORT} />);
    send({ type: 'graph', graph });
    send({
      type: 'authored',
      components: graph.components.map((c) => c.id),
      events: graph.events.map((e) => e.id),
    });

    // The router node renders at the root level with its attach summary.
    const router = [...container.querySelectorAll('.node.router')].find((n) =>
      n.textContent?.includes('R0'),
    )!;
    expect(router).not.toBeNull();
    expect(router.textContent).toContain('2 attached');
    expect(router.textContent).toContain('lat 1');

    // Attachment edges (CPU0⇌R0, Memory1⇌R0) render as fabric bus paths.
    expect(container.querySelectorAll('.wire-fabric').length).toBe(2);

    // No cross-top wire error — the dataflow is rule-derived.
    expect(container.querySelector('.wire-fabric-error')).toBeNull();

    // The rule renders as a derived ghost edge CPU0 → Memory1 with its
    // message as the label; clicking it selects the owning router, whose
    // inspector opens on the Forwarding rules card.
    const derived = container.querySelector('.wire-derived')!;
    expect(derived).not.toBeNull();
    expect(derived.querySelector('.wire-derived-label')?.textContent).toBe('MemRequest');
    act(() => {
      fireEvent.pointerDown(derived.querySelector('.wire-hit')!);
    });
    const inspector = container.querySelector('.inspector')!;
    expect(inspector.textContent).toContain('Forwarding rules');
    expect(inspector.textContent).toContain('MemRequest');
    expect(inspector.textContent).toContain('+ Add rule');

    // Token-flight geometry: fabric hops (leaf→router, router→leaf) resolve
    // to the drawn attachment lines instead of the node-box fallback — send
    // a routed trace and expect one flight bubble per in-flight token.
    send({
      type: 'trace',
      trace: {
        hops: [
          { token: 0, from: 'CPU0.MEM', to: 'R0', event: 'MemRequest', depart: 0, arrive: 2 },
          { token: 0, from: 'R0', to: 'Memory1', event: 'MemRequest', depart: 2, arrive: 4 },
        ],
        divergences: [],
        cycles: 5,
        source: 'synthetic',
      },
    });
    expect(container.querySelectorAll('.token-flight, .token-dwell').length).toBeGreaterThan(0);
  });

  it('warns when arrivals extend past the clock stop (undelivered events)', () => {
    const graph = sampleGraph();
    const { container } = render(<CanvasApp transport={TEST_TRANSPORT} />);
    send({ type: 'graph', graph });

    // Engine ran 64 cycles, but a latency-100 wire carries arrivals to 153.
    send({
      type: 'trace',
      trace: {
        hops: [
          { token: 0, from: 'CPU0.IF', to: 'CPU0.DE', event: 'FetchEvent', depart: 0, arrive: 1 },
          { token: 1, from: 'CPU0.MEM', to: 'Memory1', event: 'MemRequest', depart: 53, arrive: 153 },
        ],
        divergences: [],
        cycles: 154,
        ranCycles: 64,
        source: 'run' as const,
      },
    });

    // Status bar flags the truncated run.
    expect(container.querySelector('.status-bar .sb-warn')?.textContent).toContain('ran 64');

    // PROBLEMS carries the warning (and counts it in the tab label).
    const problemsTab = [...container.querySelectorAll('.panel-tabs button')].find((b) =>
      b.textContent?.includes('PROBLEMS'),
    )!;
    expect(problemsTab.textContent).toContain('(1)');
    act(() => {
      (problemsTab as HTMLButtonElement).click();
    });
    const warning = container.querySelector('.console-warning')!;
    expect(warning.textContent).toContain('never delivered');
    expect(warning.textContent).toContain('64');
    expect(warning.textContent).toContain('153');
    expect(warning.textContent).toContain('CPU0.MEM → Memory1');

    // PIPELINE columns past the stop are dimmed as wire-flight-only.
    const pipelineTab = [...container.querySelectorAll('.panel-tabs button')].find((b) =>
      b.textContent?.includes('PIPELINE'),
    )!;
    act(() => {
      (pipelineTab as HTMLButtonElement).click();
    });
    expect(container.querySelectorAll('.pipe-grid th.undelivered').length).toBe(154 - 64);
  });

  it('renders unresolved links and stubs visibly', () => {
    const graph = sampleGraph();
    // Fabricate an unresolved link + a stub at the ROOT level.
    graph.links.push({
      id: 'Memory1.dbg',
      from: 'Memory1',
      fromPort: 'dbg',
      to: null,
      message: 'DebugEvent',
      latency: null,
      status: 'unresolved',
    });
    graph.stubs.push({ from: 'Memory1', port: 'spare', message: 'SpareEvent', reason: 'no consumer' });

    const { container } = render(<CanvasApp transport={TEST_TRANSPORT} />);
    send({ type: 'graph', graph });

    expect(container.querySelectorAll('.wire-unresolved').length).toBe(1);
    expect(container.querySelectorAll('.wire-stub').length).toBe(1);
    expect(container.textContent).toContain('no consumer');
  });
});
