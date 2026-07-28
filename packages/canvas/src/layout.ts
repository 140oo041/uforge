// Pure canvas geometry: node boxes, port anchors, hierarchy level filtering,
// edge aggregation, auto-layout, edge paths. No DOM, no React — unit-testable
// headless.

import type { Graph, GraphComponent, LinkStatus } from '@iss/contracts/graph';
import type { LayoutMap } from '@iss/contracts/messaging';

export const NODE_WIDTH = 200;
export const NODE_HEADER = 34;
export const PORT_ROW = 20;
export const VAR_ROW = 16;
export const NODE_PAD = 10;
export const GRID = 8;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * In-port rows of a leaf: the events it consumes, one row each (sorted so
 * anchors are stable). The same event name therefore shows on BOTH ends of a
 * wire — the producer's out row and the consumer's in row.
 */
export function inRowsOf(comp: GraphComponent): string[] {
  if (comp.kind !== 'leaf') return [];
  return [...comp.consumes].sort();
}

/**
 * A composite's boundary rows: its I/O pin children (in pins first, then out
 * pins — same stacking convention as leaf ports). These are the "input/output
 * fields" of the minimized composite node.
 */
export function compositePinRows(comp: GraphComponent) {
  const pins = comp.pins ?? [];
  return [...pins.filter((p) => p.io === 'in'), ...pins.filter((p) => p.io === 'out')];
}

/** A folded block is just its header — wires still meet it, at its edge. */
export function nodeHeight(comp: GraphComponent, collapsed = false): number {
  if (collapsed) return NODE_HEADER;
  if (comp.kind === 'router') return NODE_HEADER + PORT_ROW + NODE_PAD;
  if (comp.kind === 'composite') {
    const rows = Math.max(compositePinRows(comp).length, 1);
    return NODE_HEADER + rows * PORT_ROW + NODE_PAD;
  }
  const portRows = Math.max(inRowsOf(comp).length + comp.outPorts.length, 1);
  const varRows = comp.vars.length;
  return NODE_HEADER + portRows * PORT_ROW + (varRows > 0 ? 6 + varRows * VAR_ROW : 0) + NODE_PAD;
}

export function nodeBox(
  comp: GraphComponent,
  layout: LayoutMap,
  collapsed?: ReadonlySet<string>,
): Box {
  const pos = layout[comp.id] ?? { x: 0, y: 0 };
  return {
    x: pos.x,
    y: pos.y,
    w: NODE_WIDTH,
    h: nodeHeight(comp, collapsed?.has(comp.id) ?? false),
  };
}

/** Keep an anchor inside its node. A folded block has no port rows to sit on,
 *  so every wire that used to land on one lands on its bottom edge instead. */
export function clampToBox(box: Box, y: number): number {
  return Math.min(y, box.y + box.h - 3);
}

/** Anchor of an out-port dot: right edge, below the in-port rows. */
export function outPortAnchor(
  comp: GraphComponent,
  layout: LayoutMap,
  port: string,
  collapsed?: ReadonlySet<string>,
) {
  const box = nodeBox(comp, layout, collapsed);
  const index = Math.max(
    0,
    comp.outPorts.findIndex((p) => p.name === port),
  );
  const row = inRowsOf(comp).length + index;
  return {
    x: box.x + box.w,
    y: clampToBox(box, box.y + NODE_HEADER + row * PORT_ROW + PORT_ROW / 2),
  };
}

/** Anchor of an in-port row (by consumed message): left edge, top rows. */
export function inPortAnchor(
  comp: GraphComponent,
  layout: LayoutMap,
  message: string,
  collapsed?: ReadonlySet<string>,
): { x: number; y: number } | null {
  const box = nodeBox(comp, layout, collapsed);
  const index = inRowsOf(comp).indexOf(message);
  if (index < 0) return null;
  return {
    x: box.x,
    y: clampToBox(box, box.y + NODE_HEADER + index * PORT_ROW + PORT_ROW / 2),
  };
}

/** Anchor of a composite's boundary pin row: left edge for in, right for out. */
export function compositePinAnchor(
  comp: GraphComponent,
  layout: LayoutMap,
  pinId: string,
  collapsed?: ReadonlySet<string>,
): { x: number; y: number } | null {
  const rows = compositePinRows(comp);
  const index = rows.findIndex((p) => p.id === pinId);
  if (index < 0) return null;
  const box = nodeBox(comp, layout, collapsed);
  const x = rows[index].io === 'in' ? box.x : box.x + box.w;
  return { x, y: clampToBox(box, box.y + NODE_HEADER + index * PORT_ROW + PORT_ROW / 2) };
}

/** Generic out anchor for composite (aggregated) edges: right edge, spread. */
export function outAnchor(
  comp: GraphComponent,
  layout: LayoutMap,
  slot: number,
  slots: number,
  collapsed?: ReadonlySet<string>,
) {
  const box = nodeBox(comp, layout, collapsed);
  const usable = Math.max(box.h - NODE_HEADER, PORT_ROW);
  const step = slots > 0 ? usable / (slots + 1) : usable / 2;
  return {
    x: box.x + box.w,
    y: clampToBox(box, box.y + NODE_HEADER + step * (slot + 1)),
  };
}

/** Anchor for inbound wires: left edge; `slot` spreads parallel wires. */
export function inAnchor(
  comp: GraphComponent,
  layout: LayoutMap,
  slot: number,
  slots: number,
  collapsed?: ReadonlySet<string>,
) {
  const box = nodeBox(comp, layout, collapsed);
  const usable = Math.max(box.h - NODE_HEADER, PORT_ROW);
  const step = slots > 0 ? usable / (slots + 1) : usable / 2;
  return { x: box.x, y: clampToBox(box, box.y + NODE_HEADER + step * (slot + 1)) };
}

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

// ---------------------------------------------------------------------------
// Hierarchy: what's visible at a drill level, and how leaf-to-leaf links
// project onto it.

/** The node visible at `level` that is (or contains) `id`; null if outside. */
export function ancestorAt(id: string, level: string | null): string | null {
  if (level === null) return id.split('.')[0];
  if (id === level || !id.startsWith(`${level}.`)) return null;
  const rest = id.slice(level.length + 1);
  return `${level}.${rest.split('.')[0]}`;
}

export function visibleComponents(graph: Graph, level: string | null): GraphComponent[] {
  return graph.components.filter((c) => c.parent === level);
}

/** An edge as drawn at one drill level (possibly aggregating many links). */
export interface LevelEdge {
  key: string;
  /** Visible source node id; null = source outside this level (inbound). */
  from: string | null;
  /** Visible dest node id; null = dangling (unresolved or external). */
  to: string | null;
  /** Set when the source is the actual leaf — anchors to the port slot. */
  fromPort: string | null;
  /** Set when this is exactly one underlying link — selectable in the UI. */
  linkId: string | null;
  /** Underlying leaf endpoints (single-link edges only; null once aggregated).
   *  Lets wires land on a composite's boundary pin row. */
  fromLeaf: string | null;
  toLeaf: string | null;
  message: string;
  latency: number | null;
  status: LinkStatus;
  count: number;
  /** "→ Memory1" / "from CPU0.WB" when the other endpoint is outside. */
  externalLabel?: string;
  /** Router path when the underlying wire is fabric-routed (single-link only). */
  via?: string[];
  /** Cross-component wire without a fabric route — an error badge. */
  fabricError?: string;
}

const worst = (a: LinkStatus, b: LinkStatus): LinkStatus => {
  const rank: Record<LinkStatus, number> = { wired: 0, routed: 1, inferred: 2, unresolved: 3 };
  return rank[a] >= rank[b] ? a : b;
};

export function levelEdges(graph: Graph, level: string | null): LevelEdge[] {
  const out: LevelEdge[] = [];
  const aggregated = new Map<string, LevelEdge>();
  for (const link of graph.links) {
    const from = ancestorAt(link.from, level);
    const to = link.to === null ? null : ancestorAt(link.to, level);

    if (from === null && to === null) continue; // entirely elsewhere
    if (from !== null && to !== null && from === to) continue; // internal

    if (from === null) {
      // Inbound from outside the level.
      out.push({
        key: `ext>${link.id}`,
        from: null,
        to,
        fromPort: null,
        linkId: null,
        fromLeaf: link.from,
        toLeaf: link.to,
        message: link.message,
        latency: link.latency,
        status: link.status,
        count: 1,
        externalLabel: `from ${link.from}.${link.fromPort}`,
      });
      continue;
    }
    if (to === null) {
      // Unresolved, or resolved to a destination outside the level.
      out.push({
        key: `${link.id}>ext`,
        from,
        to: null,
        fromPort: from === link.from ? link.fromPort : null,
        linkId: link.to === null && from === link.from ? link.id : null,
        fromLeaf: link.from,
        toLeaf: link.to,
        message: link.message,
        latency: link.latency,
        status: link.status,
        count: 1,
        externalLabel: link.to !== null ? `→ ${link.to}` : undefined,
      });
      continue;
    }

    const direct = from === link.from && to === link.to;
    const key = `${from}|${to}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.count++;
      existing.status = worst(existing.status, link.status);
      existing.linkId = null; // more than one — not directly selectable
      existing.fromLeaf = null;
      existing.toLeaf = null;
      delete existing.via;
      if (link.fabricError) existing.fabricError = link.fabricError;
      if (!direct) existing.fromPort = null;
    } else {
      aggregated.set(key, {
        key,
        from,
        to,
        fromPort: direct ? link.fromPort : null,
        linkId: direct ? link.id : null,
        fromLeaf: link.from,
        toLeaf: link.to,
        message: link.message,
        latency: direct ? link.latency : null,
        status: link.status,
        count: 1,
        ...(link.via ? { via: link.via } : {}),
        ...(link.fabricError ? { fabricError: link.fabricError } : {}),
      });
    }
  }
  return [...aggregated.values(), ...out];
}

/**
 * The blocks the simulation will seed: the run config's explicit entries when
 * set, otherwise the auto heuristic mirroring the harness generator's
 * entryLeaves() — leaves nobody sends to (alphabetical fallback).
 */
/** Fabric geometry: one center-to-center segment per attachment and trunk —
 *  shared by the fabric-edge render AND the token-flight path lookup, so a
 *  routed packet animates along the drawn attachment/trunk lines instead of
 *  floating between node boxes. Attachments: aId = component, bId = router. */
export interface GeoEdge {
  aId: string;
  bId: string;
  a: { x: number; y: number };
  b: { x: number; y: number };
  kind: 'attach' | 'trunk';
}

export function fabricGeoEdges(
  fabric: Graph['fabric'],
  boxOf: (id: string) => Box | null,
): GeoEdge[] {
  if (!fabric) return [];
  const centerOf = (id: string) => {
    const b = boxOf(id);
    return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
  };
  const out: GeoEdge[] = [];
  for (const at of fabric.attachments) {
    const a = centerOf(at.component);
    const b = centerOf(at.router);
    if (a && b) out.push({ aId: at.component, bId: at.router, a, b, kind: 'attach' });
  }
  for (const trunk of fabric.trunks) {
    const a = centerOf(trunk.a);
    const b = centerOf(trunk.b);
    if (a && b) out.push({ aId: trunk.a, bId: trunk.b, a, b, kind: 'trunk' });
  }
  return out;
}

export function entryBlocksOf(
  graph: Graph,
  entries: Array<{ block: string }>,
): Set<string> {
  const leaves = graph.components.filter((c) => c.kind === 'leaf');
  if (entries.length > 0) {
    const ids = new Set(leaves.map((c) => c.id));
    return new Set(entries.map((e) => e.block).filter((id) => ids.has(id)));
  }
  const targets = new Set(graph.links.filter((l) => l.to !== null).map((l) => l.to!));
  // Rule-derived dataflow feeds its destinations too: any leaf under a
  // derived edge's target top that consumes the edge's message is fed by
  // the fabric, not an entry.
  for (const d of graph.derived ?? [])
    for (const c of leaves) {
      if (c.id !== d.toTop && !c.id.startsWith(`${d.toTop}.`)) continue;
      if (d.message === null || c.consumes.includes(d.message)) targets.add(c.id);
    }
  const auto = leaves.filter((c) => !targets.has(c.id));
  if (auto.length > 0) return new Set(auto.map((c) => c.id));
  const first = [...leaves].sort((a, b) => a.id.localeCompare(b.id))[0];
  return new Set(first ? [first.id] : []);
}

/** Slot assignment for inbound level-edges per destination (stable by key). */
export function inSlotsFor(edges: LevelEdge[]): Map<string, { slot: number; slots: number }> {
  const byDest = new Map<string, LevelEdge[]>();
  for (const e of edges) {
    if (!e.to) continue;
    if (!byDest.has(e.to)) byDest.set(e.to, []);
    byDest.get(e.to)!.push(e);
  }
  const out = new Map<string, { slot: number; slots: number }>();
  for (const group of byDest.values()) {
    group.sort((a, b) => a.key.localeCompare(b.key));
    group.forEach((e, i) => out.set(e.key, { slot: i, slots: group.length }));
  }
  return out;
}

/** Slot assignment for composite (non-port) out anchors per source. */
export function outSlotsFor(edges: LevelEdge[]): Map<string, { slot: number; slots: number }> {
  const bySource = new Map<string, LevelEdge[]>();
  for (const e of edges) {
    if (!e.from || e.fromPort !== null) continue; // port-anchored edges skip
    if (!bySource.has(e.from)) bySource.set(e.from, []);
    bySource.get(e.from)!.push(e);
  }
  const out = new Map<string, { slot: number; slots: number }>();
  for (const group of bySource.values()) {
    group.sort((a, b) => a.key.localeCompare(b.key));
    group.forEach((e, i) => out.set(e.key, { slot: i, slots: group.length }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-layout: longest-path layering + barycenter within-rank ordering, with
// disconnected islands stacked below (never piled into column 0), and
// back-edges tolerated (they render as loop-around curves). Operates on ONE
// drill level: pass the visible nodes and their level edges.

const COL_GAP = 110;
const ROW_GAP = 40;

export function autoLayout(
  nodes: GraphComponent[],
  edges: Array<{ from: string | null; to: string | null }>,
): LayoutMap {
  const ids = nodes.map((c) => c.id);
  const idSet = new Set(ids);
  const links = edges.filter(
    (e): e is { from: string; to: string } =>
      e.from !== null && e.to !== null && idSet.has(e.from) && idSet.has(e.to),
  );

  // Longest-path ranks over a DAG view (back-edges via DFS greying ignored).
  const indeg = new Map<string, number>();
  for (const id of ids) indeg.set(id, 0);
  const seen = new Set<string>();
  const inStack = new Set<string>();
  const dagEdges: Array<[string, string]> = [];
  const visit = (id: string) => {
    seen.add(id);
    inStack.add(id);
    for (const l of links.filter((e) => e.from === id)) {
      if (inStack.has(l.to)) continue; // back-edge: keep rendering, skip for ranks
      dagEdges.push([id, l.to]);
      if (!seen.has(l.to)) visit(l.to);
    }
    inStack.delete(id);
  };
  for (const id of ids) if (!seen.has(id)) visit(id);
  for (const [, t] of dagEdges) indeg.set(t, (indeg.get(t) ?? 0) + 1);

  const rank = new Map<string, number>();
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of queue) rank.set(id, 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const [f, t] of dagEdges) {
      if (f !== id) continue;
      const r = Math.max(rank.get(t) ?? 0, (rank.get(id) ?? 0) + 1);
      rank.set(t, r);
      indeg.set(t, (indeg.get(t) ?? 1) - 1);
      if ((indeg.get(t) ?? 0) === 0) queue.push(t);
    }
  }

  // Connected components → islands; wired islands first, unwired below.
  const adj = new Map<string, Set<string>>();
  for (const id of ids) adj.set(id, new Set());
  for (const l of links) {
    adj.get(l.from)!.add(l.to);
    adj.get(l.to)!.add(l.from);
  }
  const islandOf = new Map<string, number>();
  let islands = 0;
  for (const id of ids) {
    if (islandOf.has(id)) continue;
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (islandOf.has(cur)) continue;
      islandOf.set(cur, islands);
      for (const n of adj.get(cur)!) stack.push(n);
    }
    islands++;
  }

  const layout: LayoutMap = {};
  let islandY = 40;
  for (let island = 0; island < islands; island++) {
    const members = nodes.filter((c) => islandOf.get(c.id) === island);
    if (members.length === 0) continue;

    const cols = new Map<number, GraphComponent[]>();
    for (const comp of members) {
      const r = rank.get(comp.id) ?? 0;
      if (!cols.has(r)) cols.set(r, []);
      cols.get(r)!.push(comp);
    }
    const sortedRanks = [...cols.keys()].sort((a, b) => a - b);

    // Barycenter sweep (two passes) to reduce crossings.
    const orderIndex = new Map<string, number>();
    for (const r of sortedRanks) cols.get(r)!.forEach((c, i) => orderIndex.set(c.id, i));
    for (let pass = 0; pass < 2; pass++) {
      for (const r of sortedRanks) {
        const col = cols.get(r)!;
        const bary = (comp: GraphComponent): number => {
          const neighbors = links
            .filter((l) => l.to === comp.id || l.from === comp.id)
            .map((l) => (l.to === comp.id ? l.from : l.to))
            .filter((n) => (rank.get(n) ?? 0) !== r);
          if (neighbors.length === 0) return orderIndex.get(comp.id) ?? 0;
          return neighbors.reduce((s, n) => s + (orderIndex.get(n) ?? 0), 0) / neighbors.length;
        };
        col.sort((a, b) => bary(a) - bary(b));
        col.forEach((c, i) => orderIndex.set(c.id, i));
      }
    }

    let islandBottom = islandY;
    for (const r of sortedRanks) {
      const col = cols.get(r)!;
      let y = islandY;
      for (const comp of col) {
        layout[comp.id] = { x: 40 + r * (NODE_WIDTH + COL_GAP), y: snap(y) };
        y += nodeHeight(comp) + ROW_GAP;
      }
      islandBottom = Math.max(islandBottom, y);
    }
    islandY = islandBottom + ROW_GAP * 1.5;
  }
  return layout;
}

// ---------------------------------------------------------------------------
// Edge paths: cubic curves with horizontal tangents; back-edges loop around;
// parallel edges into one node land on distinct slots (computed by caller).

/**
 * How wires are drawn. Curvy is the default and reads well when edges fan out;
 * square is Manhattan routing, which is how silicon actually routes and is far
 * easier to follow when many wires run in parallel down a pipeline.
 */
export type WireStyle = 'curvy' | 'square';

/** Corner rounding on square routing — a hard 90° corner reads as an artifact. */
const ELBOW = 6;

/**
 * Orthogonal routing: out to a mid-x, across, then in. Corners are rounded by a
 * few pixels with arcs so the path reads as a drawn trace rather than as a
 * staircase of hairlines.
 */
function squarePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dy = to.y - from.y;
  if (Math.abs(dy) < 1) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;

  const dx = to.x - from.x;
  const sy = Math.sign(dy);

  if (dx >= 2 * ELBOW + 8) {
    // Forward: a single dog-leg at the midpoint.
    const midX = from.x + dx / 2;
    const r = Math.min(ELBOW, Math.abs(dy) / 2, Math.abs(dx) / 2);
    return (
      `M ${from.x} ${from.y} L ${midX - r} ${from.y} ` +
      `Q ${midX} ${from.y} ${midX} ${from.y + sy * r} ` +
      `L ${midX} ${to.y - sy * r} ` +
      `Q ${midX} ${to.y} ${midX + r} ${to.y} ` +
      `L ${to.x} ${to.y}`
    );
  }

  // Back-edge: out right, down/up past both, back in from the left.
  const out = 28;
  const midY = from.y + dy / 2;
  const r = Math.min(ELBOW, Math.abs(dy) / 4);
  const ax = from.x + out;
  const bx = to.x - out;
  return (
    `M ${from.x} ${from.y} L ${ax - r} ${from.y} ` +
    `Q ${ax} ${from.y} ${ax} ${from.y + sy * r} ` +
    `L ${ax} ${midY - sy * r} Q ${ax} ${midY} ${ax - r} ${midY} ` +
    `L ${bx + r} ${midY} Q ${bx} ${midY} ${bx} ${midY + sy * r} ` +
    `L ${bx} ${to.y - sy * r} Q ${bx} ${to.y} ${bx + r} ${to.y} ` +
    `L ${to.x} ${to.y}`
  );
}

export function wirePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  style: WireStyle = 'curvy',
): string {
  if (style === 'square') return squarePath(from, to);
  const dx = to.x - from.x;
  if (dx >= 24) {
    const c = Math.min(Math.max(dx * 0.45, 32), 160);
    return `M ${from.x} ${from.y} C ${from.x + c} ${from.y}, ${to.x - c} ${to.y}, ${to.x} ${to.y}`;
  }
  // Back-edge: swing out right, loop under/over, come in from the left.
  const swing = 56;
  const lift = from.y <= to.y ? 1 : -1;
  const midY = (from.y + to.y) / 2 + lift * 48;
  return (
    `M ${from.x} ${from.y} ` +
    `C ${from.x + swing} ${from.y}, ${from.x + swing} ${midY}, ${(from.x + to.x) / 2} ${midY} ` +
    `C ${to.x - swing} ${midY}, ${to.x - swing} ${to.y}, ${to.x} ${to.y}`
  );
}

/** Point at parametric t∈[0,1] along the same geometry as wirePath. */
export function pointAlong(
  from: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const clamped = Math.max(0, Math.min(1, t));
  const dx = to.x - from.x;
  const cubic = (p0: number, p1: number, p2: number, p3: number, u: number) => {
    const v = 1 - u;
    return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3;
  };
  if (dx >= 24) {
    const c = Math.min(Math.max(dx * 0.45, 32), 160);
    return {
      x: cubic(from.x, from.x + c, to.x - c, to.x, clamped),
      y: cubic(from.y, from.y, to.y, to.y, clamped),
    };
  }
  const swing = 56;
  const lift = from.y <= to.y ? 1 : -1;
  const midY = (from.y + to.y) / 2 + lift * 48;
  const mid = { x: (from.x + to.x) / 2, y: midY };
  if (clamped < 0.5) {
    const u = clamped * 2;
    return {
      x: cubic(from.x, from.x + swing, from.x + swing, mid.x, u),
      y: cubic(from.y, from.y, midY, mid.y, u),
    };
  }
  const u = (clamped - 0.5) * 2;
  return {
    x: cubic(mid.x, to.x - swing, to.x - swing, to.x, u),
    y: cubic(mid.y, midY, to.y, to.y, u),
  };
}
