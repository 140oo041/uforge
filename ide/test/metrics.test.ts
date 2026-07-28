// Metric-record ingestion (engine JSONL → Trace.metrics) and the pure
// webview derivations that drive the canvas heat overlay and METRICS tab.

import { describe, expect, it } from 'vitest';
import { withTimebase } from './helpers/trace';
import {
  displayCycle,
  displayCycles,
  formatTime,
  tickStride,
} from '@iss/contracts/trace';

import { EMPTY_GRAPH } from '@iss/contracts/graph';
import type { Hop, MetricSample, Trace } from '@iss/contracts/trace';
import { parseTrace } from '@iss/host/trace/parse';
import {
  heatStep,
  histogram,
  linkBandwidthAt,
  metricsSummary,
  pathLatencies,
  queueDepthAt,
  routerDepthTotals,
} from '@iss/canvas/metrics';
import { tokenTimelines } from '@iss/canvas/tokenAnim';

const MIXED_JSONL = [
  '{"token":0,"from":"Gen1","to":"R0","event":"ReqEvent","depart":0,"arrive":1}',
  '{"metric":"qdepth","cycle":1,"component":"R0","port":"Memory1","value":3}',
  '{"metric":"flow","cycle":1,"component":"R0","port":"Memory1","value":1}',
  '{"diverge":true,"cycle":2,"component":"R0","token":4,"detail":"packet dropped: queue full on port to Memory1","kind":"drop"}',
  '{"metric":"stall","cycle":2,"component":"R0","port":"Memory1","value":2}',
  '{"metric":"custom-future-metric","cycle":3,"component":"R0","value":9}',
  '{"token":0,"from":"R0","to":"Memory1","event":"ReqEvent","depart":1,"arrive":2}',
].join('\n');

describe('metric record parsing', () => {
  it('collects metric lines into Trace.metrics with hops/divergences unchanged', () => {
    const trace = parseTrace(withTimebase(MIXED_JSONL), EMPTY_GRAPH, 8);

    expect(trace.hops).toHaveLength(2);
    expect(trace.hops[1]).toEqual({
      token: 0,
      from: 'R0',
      to: 'Memory1',
      event: 'ReqEvent',
      depart: 1,
      arrive: 2,
    });
    expect(trace.divergences).toHaveLength(1);
    expect(trace.ticks).toBe(3);
    expect(trace.ranTicks).toBe(8);

    expect(trace.metrics).toHaveLength(4);
    expect(trace.metrics![0]).toEqual({
      metric: 'qdepth',
      cycle: 1,
      component: 'R0',
      port: 'Memory1',
      value: 3,
    });
    expect(trace.metrics![2]).toEqual({
      metric: 'stall',
      cycle: 2,
      component: 'R0',
      port: 'Memory1',
      value: 2,
    });
  });

  it('tolerates unknown metric names and port-less samples', () => {
    const trace = parseTrace(withTimebase(MIXED_JSONL), EMPTY_GRAPH);
    const future = trace.metrics!.find((m) => m.metric === 'custom-future-metric')!;
    expect(future.value).toBe(9);
    expect(future.port).toBeUndefined();
  });

  it('maps divergence kind "drop" to provenance drop', () => {
    const trace = parseTrace(withTimebase(MIXED_JSONL), EMPTY_GRAPH);
    expect(trace.divergences[0].provenance).toBe('drop');
    expect(trace.divergences[0].token).toBe(4);
  });

  it('old traces without metric lines parse to an empty metrics list', () => {
    const trace = parseTrace(
      withTimebase('{"token":0,"from":"A","to":"B","event":"E","depart":0,"arrive":1}'),
      EMPTY_GRAPH,
    );
    expect(trace.hops).toHaveLength(1);
    expect(trace.metrics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure derivations (webview/metrics.ts)

const hop = (token: number, from: string, to: string, depart: number, arrive: number): Hop => ({
  token,
  from,
  to,
  event: 'Req',
  depart,
  arrive,
});

describe('linkBandwidthAt', () => {
  const hops = [hop(0, 'A', 'R', 0, 1), hop(1, 'A', 'R', 2, 3), hop(2, 'A', 'R', 20, 21)];

  it('counts only departs inside the trailing window', () => {
    expect(linkBandwidthAt(hops, 3, 4)!.get('A->R')).toBeCloseTo(2 / 4);
    // At playhead 21 with window 4, only the depart at 20 is inside.
    expect(linkBandwidthAt(hops, 21, 4)!.get('A->R')).toBeCloseTo(1 / 4);
    // Quiet window → link absent.
    expect(linkBandwidthAt(hops, 10, 4).has('A->R')).toBe(false);
  });

  it('early playheads normalize by the elapsed span, not the full window', () => {
    expect(linkBandwidthAt(hops, 0, 16)!.get('A->R')).toBeCloseTo(1); // 1 pkt / 1 cycle seen
  });
});

describe('queue depth samples', () => {
  const samples: MetricSample[] = [
    { metric: 'qdepth', cycle: 1, component: 'R0', port: 'B', value: 3 },
    { metric: 'qdepth', cycle: 4, component: 'R0', port: 'B', value: 1 },
    { metric: 'qdepth', cycle: 2, component: 'R0', port: 'C', value: 2 },
    { metric: 'flow', cycle: 1, component: 'R0', port: 'B', value: 9 }, // ignored
  ];

  it('last sample at or before the playhead wins; before the first = absent', () => {
    expect(queueDepthAt(samples, 0).size).toBe(0);
    expect(queueDepthAt(samples, 1).get('R0|B')).toBe(3);
    expect(queueDepthAt(samples, 3).get('R0|B')).toBe(3);
    expect(queueDepthAt(samples, 9).get('R0|B')).toBe(1);
  });

  it('routerDepthTotals sums ports per component', () => {
    expect(routerDepthTotals(samples, 3).get('R0')).toBe(5); // B:3 + C:2
    expect(routerDepthTotals(samples, 9).get('R0')).toBe(3); // B:1 + C:2
  });
});

describe('pathLatencies + histogram', () => {
  it('measures first-departure → first-arrival per token, in order', () => {
    const trace: Trace = {
      hops: [
        hop(0, 'A', 'R', 0, 1),
        hop(0, 'R', 'B', 1, 2),
        hop(1, 'A', 'R', 2, 3),
        hop(1, 'R', 'B', 4, 8), // queued a while
        hop(2, 'X', 'Y', 0, 1), // never touches the path
      ],
      divergences: [],
      ticks: 9,
      source: 'run',
    };
    expect(pathLatencies(tokenTimelines(trace), 'A', 'B')).toEqual([2, 6]);
    expect(pathLatencies(tokenTimelines(trace), 'A', 'Z')).toEqual([]);
  });

  it('histogram buckets cover the range; single-value ranges collapse', () => {
    expect(histogram([5, 5, 5])).toEqual([{ lo: 5, hi: 5, n: 3 }]);
    const buckets = histogram([1, 2, 3, 4, 5, 5], 4);
    expect(buckets.reduce((s, b) => s + b.n, 0)).toBe(6);
    expect(buckets[0].lo).toBe(1);
    expect(buckets[buckets.length - 1].hi).toBe(5);
    expect(histogram([])).toEqual([]);
  });
});

describe('metricsSummary + heatStep', () => {
  it('aggregates links from hops and router ports from metric records', () => {
    const trace: Trace = {
      hops: [hop(0, 'A', 'R', 0, 1), hop(1, 'A', 'R', 0, 1), hop(0, 'R', 'B', 1, 2)],
      divergences: [],
      metrics: [
        { metric: 'qdepth', cycle: 1, component: 'R', port: 'B', value: 2 },
        { metric: 'qdepth', cycle: 2, component: 'R', port: 'B', value: 0 },
        { metric: 'stall', cycle: 1, component: 'R', port: 'B', value: 3 },
        { metric: 'flow', cycle: 1, component: 'R', port: 'B', value: 1 },
      ],
      ticks: 3,
      source: 'run',
    };
    const { links, routers } = metricsSummary(trace);
    expect(links[0]).toMatchObject({ from: 'A', to: 'R', packets: 2, peakPerCycle: 2 });
    expect(routers).toHaveLength(1);
    expect(routers[0]).toMatchObject({ component: 'R', port: 'B', maxDepth: 2, stalls: 3, flow: 1 });
    expect(routers[0].meanDepth).toBeCloseTo(1);
  });

  it('heatStep maps 0 to 0 and scales into 1..4', () => {
    expect(heatStep(0, 10)).toBe(0);
    expect(heatStep(1, 10)).toBe(1);
    expect(heatStep(5, 10)).toBe(2);
    expect(heatStep(10, 10)).toBe(4);
    expect(heatStep(3, 0)).toBe(0);
  });
});

describe('timebase', () => {
  const HOP = '{"token":0,"from":"A","to":"B","event":"E","depart":0,"arrive":1}';

  it('refuses a trace that has records but no units', () => {
    // The failure this prevents is SILENT: every depart/arrive would be read as
    // a cycle when it is a tick, the playhead would sit near 0 for the whole
    // run, and nothing would throw. Better to refuse than to guess.
    expect(() => parseTrace(HOP, EMPTY_GRAPH)).toThrow(/timebase/);
  });

  it('accepts an empty trace with no units — there is nothing to misread', () => {
    expect(() => parseTrace('', EMPTY_GRAPH)).not.toThrow();
  });

  it('carries the declared units through to the Trace', () => {
    const tb =
      '{"timebase":{"femtosPerTick":1,"reference":0,"domains":[' +
      '{"name":"cpu","periodTicks":500000,"phaseTicks":0,"syncDepth":2},' +
      '{"name":"usb","periodTicks":16666667,"phaseTicks":0,"syncDepth":3}]}}';
    const trace = parseTrace(`${tb}\n${HOP}`, EMPTY_GRAPH);
    expect(trace.timebase?.domains).toHaveLength(2);
    expect(trace.timebase?.domains[1].periodTicks).toBe(16666667);
    expect(trace.timebase?.domains[1].syncDepth).toBe(3);
  });

  it('reports ticks as reference-domain cycles', () => {
    // A real 1 GHz clock at 1 fs/tick: one cycle is 1,000,000 ticks.
    const tb =
      '{"timebase":{"femtosPerTick":1,"reference":0,"domains":[' +
      '{"name":"noc","periodTicks":1000000,"phaseTicks":0,"syncDepth":0}]}}';
    const hop = '{"token":0,"from":"A","to":"B","event":"E","depart":0,"arrive":3000000}';
    const trace = parseTrace(`${tb}\n${hop}`, EMPTY_GRAPH);

    // The raw timeline is ticks; a reader thinks in cycles.
    expect(trace.ticks).toBe(3000001);
    expect(tickStride(trace)).toBe(1000000);
    expect(displayCycle(trace, 3000000)).toBe(3);
    expect(displayCycles(trace)).toBe(4);
    expect(formatTime(trace, 3000000)).toBe('3.00 ns');
  });
});
