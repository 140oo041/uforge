// SoC performance metrics: pure functions of (trace, playhead), tokenAnim
// style — no DOM, no React, deterministic under scrubbing in any direction.
//
// Derivation split: per-link bandwidth and per-path latency come from the
// hop records (they work on any run trace, old or new); queue depth and
// stall counts come from the engine's metric records (ground truth sampled
// inside the router), falling back gracefully to absent on old traces.

import type { Hop, MetricSample, Trace } from '@iss/contracts/trace';

/** Trailing window (cycles) for playhead-local bandwidth. */
export const BANDWIDTH_WINDOW = 16;

export const linkKey = (from: string, to: string): string => `${from}->${to}`;

/**
 * Packets/cycle per directed link over the trailing window ending at
 * `playhead` (hops counted by depart cycle). Links quiet in the window are
 * absent.
 */
export function linkBandwidthAt(
  hops: Hop[],
  playhead: number,
  window = BANDWIDTH_WINDOW,
): Map<string, number> {
  const lo = playhead - window;
  const counts = new Map<string, number>();
  for (const h of hops) {
    if (h.depart > playhead || h.depart <= lo) continue;
    const key = linkKey(h.from, h.to);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const span = Math.max(1, Math.min(window, playhead + 1));
  const out = new Map<string, number>();
  for (const [key, n] of counts) out.set(key, n / span);
  return out;
}

/**
 * Latest engine sample value at or before `playhead` for one metric, keyed
 * `component|port` ('' port = component-wide). Components with no sample yet
 * are absent (unknown ≠ zero).
 */
export function sampleValuesAt(
  metrics: MetricSample[],
  metric: string,
  playhead: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const at = new Map<string, number>();
  for (const m of metrics) {
    if (m.metric !== metric || m.cycle > playhead) continue;
    const key = `${m.component}|${m.port ?? ''}`;
    const prev = at.get(key);
    if (prev === undefined || m.cycle >= prev) {
      at.set(key, m.cycle);
      out.set(key, m.value);
    }
  }
  return out;
}

/** Change-only qdepth samples resolved to a per-port depth at `playhead`. */
export function queueDepthAt(metrics: MetricSample[], playhead: number): Map<string, number> {
  return sampleValuesAt(metrics, 'qdepth', playhead);
}

/** Total queued packets per component at `playhead` (ports summed). */
export function routerDepthTotals(metrics: MetricSample[], playhead: number): Map<string, number> {
  const totals = new Map<string, number>();
  for (const [key, depth] of queueDepthAt(metrics, playhead)) {
    const component = key.slice(0, key.indexOf('|'));
    totals.set(component, (totals.get(component) ?? 0) + depth);
  }
  return totals;
}

/**
 * Per-token latency (cycles) from the first departure at `from` to the first
 * arrival at `to`, over every token that visited both in that order.
 */
export function pathLatencies(
  timelines: Map<number, Hop[]>,
  from: string,
  to: string,
): number[] {
  const out: number[] = [];
  for (const hops of timelines.values()) {
    const start = hops.find((h) => h.from === from);
    if (!start) continue;
    const end = hops.find((h) => h.to === to && h.arrive >= start.depart);
    if (!end) continue;
    out.push(end.arrive - start.depart);
  }
  return out.sort((a, b) => a - b);
}

export interface HistogramBucket {
  lo: number;
  hi: number; // exclusive, except the last bucket which is inclusive
  n: number;
}

/** Equal-width buckets over the value range (single-value ranges collapse). */
export function histogram(values: number[], buckets = 8): HistogramBucket[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ lo: min, hi: max, n: values.length }];
  const count = Math.min(buckets, Math.max(1, max - min));
  const width = (max - min) / count;
  const out: HistogramBucket[] = Array.from({ length: count }, (_, i) => ({
    lo: min + i * width,
    hi: min + (i + 1) * width,
    n: 0,
  }));
  for (const v of values) {
    const i = Math.min(count - 1, Math.floor((v - min) / width));
    out[i].n += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-run summary for the METRICS dock tab.

export interface LinkStat {
  from: string;
  to: string;
  packets: number;
  /** Mean packets/cycle over the link's active span (first..last depart). */
  avgBandwidth: number;
  /** Peak packets in any single cycle. */
  peakPerCycle: number;
}

export interface RouterStat {
  component: string;
  port: string;
  maxDepth: number;
  meanDepth: number;
  stalls: number;
  flow: number;
  /** Bits forwarded on this port across the run. Bandwidth is metered in
   *  bits, so packet counts alone no longer say how loaded a port was. */
  bits: number;
}

export function metricsSummary(trace: Trace): { links: LinkStat[]; routers: RouterStat[] } {
  // Links, from hops.
  const byLink = new Map<string, { from: string; to: string; departs: number[] }>();
  for (const h of trace.hops) {
    const key = linkKey(h.from, h.to);
    if (!byLink.has(key)) byLink.set(key, { from: h.from, to: h.to, departs: [] });
    byLink.get(key)!.departs.push(h.depart);
  }
  const links: LinkStat[] = [...byLink.values()]
    .map(({ from, to, departs }) => {
      const perCycle = new Map<number, number>();
      for (const d of departs) perCycle.set(d, (perCycle.get(d) ?? 0) + 1);
      const span = Math.max(...departs) - Math.min(...departs) + 1;
      return {
        from,
        to,
        packets: departs.length,
        avgBandwidth: departs.length / span,
        peakPerCycle: Math.max(...perCycle.values()),
      };
    })
    .sort((a, b) => b.packets - a.packets || a.from.localeCompare(b.from));

  // Router ports, from engine metric records.
  const byPort = new Map<string, RouterStat & { depthSum: number; depthSamples: number }>();
  const portOf = (m: MetricSample) => `${m.component}|${m.port ?? ''}`;
  for (const m of trace.metrics ?? []) {
    if (!['qdepth', 'stall', 'flow', 'bits'].includes(m.metric)) continue;
    const key = portOf(m);
    if (!byPort.has(key))
      byPort.set(key, {
        component: m.component,
        port: m.port ?? '',
        maxDepth: 0,
        meanDepth: 0,
        stalls: 0,
        flow: 0,
        bits: 0,
        depthSum: 0,
        depthSamples: 0,
      });
    const stat = byPort.get(key)!;
    if (m.metric === 'qdepth') {
      stat.maxDepth = Math.max(stat.maxDepth, m.value);
      stat.depthSum += m.value;
      stat.depthSamples += 1;
    } else if (m.metric === 'stall') stat.stalls += m.value;
    else if (m.metric === 'bits') stat.bits += m.value;
    else stat.flow += m.value;
  }
  const routers: RouterStat[] = [...byPort.values()]
    .map(({ depthSum, depthSamples, ...stat }) => ({
      ...stat,
      meanDepth: depthSamples > 0 ? depthSum / depthSamples : 0,
    }))
    .sort(
      (a, b) =>
        a.component.localeCompare(b.component) || a.port.localeCompare(b.port),
    );

  return { links, routers };
}

/** 0..4 heat class step for a value against the run's maximum. */
export function heatStep(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((value / max) * 4)));
}
