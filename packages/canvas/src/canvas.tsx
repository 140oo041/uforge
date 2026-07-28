// The graphical editor: drag-and-drop blocks, port-to-port wire drawing,
// marquee multi-select, pan/zoom camera, live trace tokens, divergence flash,
// and hierarchy — one drill level is visible at a time; composites render as
// single nodes with aggregated edges, double-click drills in.
// Everything structural it draws comes from the parsed Graph; everything it
// changes leaves as an EditIntent (via callbacks in props).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Graph } from '@iss/contracts/graph';
import type { LayoutMap } from '@iss/contracts/messaging';
import { parseAddr, type ForwardingRule } from '@iss/contracts/model';
import type { Divergence, Trace } from '@iss/contracts/trace';
import type { Authored } from './app';
import { heatStep, linkBandwidthAt, routerDepthTotals } from './metrics';
import { congestedAt, occupancyAt, tokenPositions, tokenTimelines } from './tokenAnim';
import {
  NODE_HEADER,
  NODE_WIDTH,
  PORT_ROW,
  VAR_ROW,
  ancestorAt,
  compositePinAnchor,
  compositePinRows,
  fabricGeoEdges,
  inAnchor,
  inPortAnchor,
  inRowsOf,
  inSlotsFor,
  levelEdges,
  nodeBox,
  outAnchor,
  outPortAnchor,
  outSlotsFor,
  pointAlong,
  snap,
  visibleComponents,
  wirePath,
  type LevelEdge,
  type WireStyle,
} from './layout';

export interface Selection {
  nodes: Set<string>;
  wire: string | null;
}

interface Camera {
  x: number;
  y: number;
  z: number;
}

interface Props {
  graph: Graph;
  layout: LayoutMap;
  authored: Authored;
  selection: Selection;
  tool: 'select' | 'hand';
  trace: Trace;
  playhead: number;
  divergences: Divergence[];
  zoomTick: number;
  currentPath: string | null;
  /** Blocks the run config will seed — rendered with a ▶ entry badge. */
  entryIds: Set<string>;
  /** Node currently in inline-rename mode (label edit), owned by App for F2. */
  renamingId: string | null;
  /** How wires are drawn — curvy beziers, or Manhattan routing. */
  wireStyle?: WireStyle;
  /** Blocks folded to their header. */
  collapsed?: ReadonlySet<string>;
  onToggleCollapse?(id: string): void;
  onSelect(sel: Selection): void;
  onMove(moves: LayoutMap): void;
  onConnect(from: string, to: string, message: string, isNewEvent: boolean, latency: number): void;
  onAddBlock(
    prefix: string,
    x: number,
    y: number,
    kind?: 'leaf' | 'composite' | 'router',
    io?: 'in' | 'out',
    role?: 'trafficgen',
  ): void;
  /** Add a boundary I/O pin inside a composite viewed from outside (the pin
   *  is created as an io leaf child and shows as a new boundary port row). */
  onAddPin(compositeId: string, io: 'in' | 'out'): void;
  /** Right-click on a wire deletes it (authored guard lives in the app). */
  onDeleteWire(linkId: string): void;
  /** Fabric: attach (or, with attach=false, detach) a top-level component
   *  to/from one router. Components may attach to multiple routers. */
  onAttachRouter(component: string, router: string, attach: boolean): void;
  /** Fabric: connect/disconnect a router↔router trunk. */
  onLinkRouters(a: string, b: string, connect: boolean): void;
  /** Author one forwarding rule on a router (the cross-top drag gesture). */
  onAddRule(router: string, rule: ForwardingRule): void;
  onRenameStart(id: string): void;
  /** label === null cancels; otherwise commits the new display label. */
  onRenameEnd(id: string, label: string | null): void;
  onReveal(id: string): void;
  onRevealEvent(id: string): void;
  onDrillIn(id: string): void;
}

interface DragState {
  kind: 'nodes' | 'pan' | 'marquee' | 'wire';
  startX: number;
  startY: number;
  origins?: LayoutMap;
  wireFrom?: { comp: string; port: string | null };
  current?: { x: number; y: number };
}

interface ConnectDraft {
  from: string;
  /** Drop target — may be a composite; the form resolves an inner leaf. */
  to: string;
  screenX: number;
  screenY: number;
}

/** A cross-top drag at the root level authors a forwarding rule, not a wire. */
interface RuleDraft {
  from: string;
  to: string;
  screenX: number;
  screenY: number;
}

/** Floating card listing an event's fields (the signal-level interface). */
interface FieldCard {
  event: string;
  screenX: number;
  screenY: number;
}

const TOKEN_COLORS = ['#4fc3f7', '#ffb74d', '#aed581', '#f06292', '#ba68c8', '#4db6ac', '#fff176', '#a1887f'];

export function Canvas(props: Props) {
  const {
    graph, layout, authored, selection, tool, trace, playhead, divergences,
    zoomTick, currentPath, entryIds, renamingId, wireStyle = 'curvy',
    collapsed, onToggleCollapse, onSelect, onMove, onConnect,
    onAddBlock, onAddPin, onDeleteWire, onAttachRouter, onLinkRouters, onAddRule,
    onRenameStart, onRenameEnd, onReveal, onRevealEvent, onDrillIn,
  } = props;

  const pane = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, z: 1 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [connectDraft, setConnectDraft] = useState<ConnectDraft | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [fieldCard, setFieldCard] = useState<FieldCard | null>(null);
  const [livePositions, setLivePositions] = useState<LayoutMap | null>(null);

  const eventFields = useMemo(
    () => new Map(graph.events.map((e) => [e.id, e.fields])),
    [graph.events],
  );
  const openFieldCard = useCallback((event: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = pane.current!.getBoundingClientRect();
    setFieldCard({ event, screenX: e.clientX - rect.left, screenY: e.clientY - rect.top });
  }, []);

  const effectiveLayout = useMemo(
    () => (livePositions ? { ...layout, ...livePositions } : layout),
    [layout, livePositions],
  );

  const compById = useMemo(
    () => new Map(graph.components.map((c) => [c.id, c])),
    [graph.components],
  );
  const visible = useMemo(
    () => visibleComponents(graph, currentPath),
    [graph, currentPath],
  );
  const edges = useMemo(() => levelEdges(graph, currentPath), [graph, currentPath]);
  const inSlots = useMemo(() => inSlotsFor(edges), [edges]);
  const outSlots = useMemo(() => outSlotsFor(edges), [edges]);
  const visibleStubs = useMemo(
    () => graph.stubs.filter((s) => compById.get(s.from)?.parent === currentPath),
    [graph.stubs, compById, currentPath],
  );

  const anchorsFor = useCallback(
    (e: LevelEdge) => {
      const fromComp = e.from ? compById.get(e.from) : undefined;
      const toComp = e.to ? compById.get(e.to) : undefined;
      let a: { x: number; y: number } | undefined;
      let b: { x: number; y: number } | undefined;
      if (fromComp) {
        // Composite sources: anchor on the boundary pin row when the
        // underlying leaf is one of its I/O pins.
        a =
          (e.fromLeaf && fromComp.kind === 'composite'
            ? compositePinAnchor(fromComp, effectiveLayout, e.fromLeaf, collapsed)
            : null) ?? undefined;
        if (!a) {
          const os = outSlots.get(e.key);
          a =
            e.fromPort !== null
              ? outPortAnchor(fromComp, effectiveLayout, e.fromPort, collapsed)
              : outAnchor(fromComp, effectiveLayout, os?.slot ?? 0, os?.slots ?? 1, collapsed);
        }
      }
      if (toComp) {
        // Wires land on the consumer's in-port row (leaves) or boundary pin
        // row (composites); aggregated/unmatched edges spread along the edge.
        b =
          (e.toLeaf && toComp.kind === 'composite'
            ? compositePinAnchor(toComp, effectiveLayout, e.toLeaf, collapsed)
            : null) ??
          (e.message ? inPortAnchor(toComp, effectiveLayout, e.message, collapsed) : null) ??
          undefined;
        if (!b) {
          const s = inSlots.get(e.key);
          b = inAnchor(toComp, effectiveLayout, s?.slot ?? 0, s?.slots ?? 1, collapsed);
        }
      }
      if (a && !b) b = { x: a.x + 90, y: a.y };
      if (!a && b) a = { x: b.x - 70, y: b.y };
      return { a: a!, b: b! };
    },
    [compById, effectiveLayout, inSlots, outSlots, collapsed],
  );

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = pane.current!.getBoundingClientRect();
      return {
        x: (clientX - rect.left - camera.x) / camera.z,
        y: (clientY - rect.top - camera.y) / camera.z,
      };
    },
    [camera],
  );

  // ---- fit to content on zoomTick / level change -------------------------------
  useEffect(() => {
    if (!pane.current || visible.length === 0) return;
    const boxes = visible.map((c) => nodeBox(c, effectiveLayout, collapsed));
    const minX = Math.min(...boxes.map((b) => b.x)) - 60;
    const minY = Math.min(...boxes.map((b) => b.y)) - 60;
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + 60;
    const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + 60;
    const rect = pane.current.getBoundingClientRect();
    const z = Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY), 1.4);
    setCamera({
      z,
      x: (rect.width - (maxX - minX) * z) / 2 - minX * z,
      y: (rect.height - (maxY - minY) * z) / 2 - minY * z,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomTick, currentPath, visible.length === 0]);

  // ---- space-to-pan -------------------------------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === ' ' && !(e.target as HTMLElement).matches('input,textarea'))
        setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ---- wheel: ctrl = zoom-to-cursor, plain = pan --------------------------------
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const rect = pane.current!.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setCamera((cam) => {
        const z = Math.max(0.2, Math.min(2.5, cam.z * (e.deltaY < 0 ? 1.12 : 0.89)));
        const wx = (px - cam.x) / cam.z;
        const wy = (py - cam.y) / cam.z;
        return { z, x: px - wx * z, y: py - wy * z };
      });
    } else {
      setCamera((cam) => ({ ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY }));
    }
  }, []);

  // ---- pointer machine ------------------------------------------------------------
  // Right-button pans from anywhere — captured before node/port handlers.
  const onRootDownCapture = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 2) return;
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({ kind: 'pan', startX: e.clientX - camera.x, startY: e.clientY - camera.y });
    },
    [camera],
  );

  const onBackgroundDown = useCallback(
    (e: React.PointerEvent) => {
      if (connectDraft) setConnectDraft(null);
      if (ruleDraft) setRuleDraft(null);
      if (fieldCard) setFieldCard(null);
      const panMode = tool === 'hand' || spaceHeld || e.button === 1;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      if (panMode) {
        setDrag({ kind: 'pan', startX: e.clientX - camera.x, startY: e.clientY - camera.y });
      } else {
        const w = toWorld(e.clientX, e.clientY);
        setDrag({ kind: 'marquee', startX: w.x, startY: w.y, current: w });
        if (!e.shiftKey) onSelect({ nodes: new Set(), wire: null });
      }
    },
    [tool, spaceHeld, camera, toWorld, onSelect, connectDraft, ruleDraft, fieldCard],
  );

  const onNodeDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const nodes = new Set(selection.nodes);
      if (e.shiftKey) {
        if (nodes.has(id)) nodes.delete(id);
        else nodes.add(id);
      } else if (!nodes.has(id)) {
        nodes.clear();
        nodes.add(id);
      }
      onSelect({ nodes, wire: null });
      const origins: LayoutMap = {};
      for (const n of nodes) origins[n] = effectiveLayout[n] ?? { x: 0, y: 0 };
      const w = toWorld(e.clientX, e.clientY);
      setDrag({ kind: 'nodes', startX: w.x, startY: w.y, origins });
    },
    [selection.nodes, onSelect, effectiveLayout, toWorld],
  );

  const onPortDown = useCallback(
    (e: React.PointerEvent, comp: string, port: string | null) => {
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const w = toWorld(e.clientX, e.clientY);
      setDrag({ kind: 'wire', startX: w.x, startY: w.y, wireFrom: { comp, port }, current: w });
    },
    [toWorld],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      if (drag.kind === 'pan') {
        setCamera((cam) => ({ ...cam, x: e.clientX - drag.startX, y: e.clientY - drag.startY }));
        return;
      }
      const w = toWorld(e.clientX, e.clientY);
      if (drag.kind === 'nodes') {
        const dx = w.x - drag.startX;
        const dy = w.y - drag.startY;
        const moves: LayoutMap = {};
        for (const [id, origin] of Object.entries(drag.origins!))
          moves[id] = { x: snap(origin.x + dx), y: snap(origin.y + dy) };
        setLivePositions(moves);
      } else if (drag.kind === 'marquee' || drag.kind === 'wire') {
        setDrag({ ...drag, current: w });
      }
    },
    [drag, toWorld],
  );

  const nodeAt = useCallback(
    (x: number, y: number): string | null => {
      for (const comp of visible) {
        const b = nodeBox(comp, effectiveLayout, collapsed);
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return comp.id;
      }
      return null;
    },
    [visible, effectiveLayout, collapsed],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      const w = toWorld(e.clientX, e.clientY);
      if (drag.kind === 'nodes' && livePositions) {
        onMove(livePositions);
        setLivePositions(null);
      } else if (drag.kind === 'marquee' && drag.current) {
        const x0 = Math.min(drag.startX, drag.current.x);
        const x1 = Math.max(drag.startX, drag.current.x);
        const y0 = Math.min(drag.startY, drag.current.y);
        const y1 = Math.max(drag.startY, drag.current.y);
        if (x1 - x0 > 4 || y1 - y0 > 4) {
          const nodes = new Set(e.shiftKey ? selection.nodes : []);
          for (const comp of visible) {
            const b = nodeBox(comp, effectiveLayout, collapsed);
            if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0) nodes.add(comp.id);
          }
          onSelect({ nodes, wire: null });
        }
      } else if (drag.kind === 'wire' && drag.wireFrom) {
        const target = nodeAt(w.x, w.y);
        if (target && target !== drag.wireFrom.comp) {
          const fromKind = compById.get(drag.wireFrom.comp)?.kind;
          const toKind = compById.get(target)?.kind;
          if (fromKind === 'router' || toKind === 'router') {
            // A drag touching a router is a fabric gesture, not a wire:
            // router↔router links a trunk; component↔router attaches. Both
            // are immediate (nothing to configure) and undo-able in the app.
            if (fromKind === 'router' && toKind === 'router') {
              onLinkRouters(drag.wireFrom.comp, target, true);
            } else {
              const [comp, router] =
                fromKind === 'router' ? [target, drag.wireFrom.comp] : [drag.wireFrom.comp, target];
              onAttachRouter(comp, router, true);
            }
          } else if (currentPath === null) {
            // Root level: both endpoints are top-level units — dataflow here
            // is authored as a forwarding rule on a router, never a wire.
            const rect = pane.current!.getBoundingClientRect();
            setRuleDraft({
              from: drag.wireFrom.comp,
              to: target,
              screenX: e.clientX - rect.left,
              screenY: e.clientY - rect.top,
            });
          } else {
            const rect = pane.current!.getBoundingClientRect();
            setConnectDraft({
              from: drag.wireFrom.comp,
              to: target,
              screenX: e.clientX - rect.left,
              screenY: e.clientY - rect.top,
            });
          }
        }
      }
      setDrag(null);
    },
    [drag, toWorld, livePositions, onMove, selection.nodes, visible, effectiveLayout, onSelect, nodeAt, compById, onAttachRouter, onLinkRouters, currentPath],
  );

  // ---- palette drop --------------------------------------------------------------
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const prefix = e.dataTransfer.getData('application/x-iss-block');
      if (!prefix) return;
      e.preventDefault();
      const kindRaw = e.dataTransfer.getData('application/x-iss-kind');
      const kind =
        kindRaw === 'composite' || kindRaw === 'router' ? kindRaw : ('leaf' as const);
      const ioRaw = e.dataTransfer.getData('application/x-iss-io');
      const io = ioRaw === 'in' || ioRaw === 'out' ? ioRaw : undefined;
      const roleRaw = e.dataTransfer.getData('application/x-iss-role');
      const role = roleRaw === 'trafficgen' ? roleRaw : undefined;
      const w = toWorld(e.clientX, e.clientY);
      onAddBlock(prefix, w.x - NODE_WIDTH / 2, w.y - 20, kind, io, role);
    },
    [toWorld, onAddBlock],
  );

  // ---- fabric geometry (root level only) -----------------------------------------
  // Shared by the fabric-edge render and the token-path lookup below, so a
  // fabric-routed packet animates along the drawn attachment/trunk lines.
  const fabricGeo = useMemo(() => {
    if (currentPath !== null) return [];
    return fabricGeoEdges(graph.fabric, (id) => {
      const comp = compById.get(id);
      return comp ? nodeBox(comp, effectiveLayout, collapsed) : null;
    });
  }, [currentPath, graph.fabric, compById, effectiveLayout]);

  // ---- trace tokens (mapped up to this level's visible nodes) --------------------
  // Pure per-token positions (tokenAnim.ts): exactly one bubble per token —
  // in flight on a wire, dwelling inside a block, or gone. Rewind-safe.
  const timelines = useMemo(() => tokenTimelines(trace), [trace]);
  const tokens = useMemo(() => {
    if (trace.hops.length === 0) return [];
    // Geometry per visible (from, to) pair: authored/derived level edges
    // first, then fabric attachment + trunk segments in BOTH directions —
    // hops with a router endpoint (A→R0, R0→R1, R1→B) ride the drawn fabric
    // lines instead of the node-box fallback.
    const edgeByPair = new Map<string, { a: { x: number; y: number }; b: { x: number; y: number } }>();
    for (const e of edges) if (e.from && e.to) edgeByPair.set(`${e.from}|${e.to}`, anchorsFor(e));
    for (const g of fabricGeo) {
      if (!edgeByPair.has(`${g.aId}|${g.bId}`)) edgeByPair.set(`${g.aId}|${g.bId}`, { a: g.a, b: g.b });
      if (!edgeByPair.has(`${g.bId}|${g.aId}`)) edgeByPair.set(`${g.bId}|${g.aId}`, { a: g.b, b: g.a });
    }
    const out: Array<{ key: number; x: number; y: number; color: string; dwell: boolean }> = [];
    const dwellAt = (visibleId: string, token: number, event: string) => {
      const comp = compById.get(visibleId);
      if (!comp) return;
      const b = nodeBox(comp, effectiveLayout, collapsed);
      out.push({
        key: token,
        x: b.x + b.w / 2,
        y: b.y + NODE_HEADER / 2,
        color: TOKEN_COLORS[token % TOKEN_COLORS.length],
        dwell: true,
      });
      void event;
    };
    for (const pos of tokenPositions(timelines, playhead)) {
      if (pos.state === 'dwell') {
        const vis = ancestorAt(pos.to, currentPath);
        if (vis) dwellAt(vis, pos.token, pos.event);
        continue;
      }
      const from = ancestorAt(pos.from, currentPath);
      const to = ancestorAt(pos.to, currentPath);
      if (!from || !to) continue;
      if (from === to) {
        // The whole hop is inside one visible node — show it dwelling there.
        dwellAt(to, pos.token, pos.event);
        continue;
      }
      const fromComp = compById.get(from);
      const toComp = compById.get(to);
      if (!fromComp || !toComp) continue;
      const pair = edgeByPair.get(`${from}|${to}`);
      let a: { x: number; y: number };
      let b: { x: number; y: number };
      if (pair) {
        ({ a, b } = pair);
      } else {
        // Last resort: no drawn geometry for this pair — straight line
        // between the node boxes.
        const fb = nodeBox(fromComp, effectiveLayout, collapsed);
        const tb = nodeBox(toComp, effectiveLayout, collapsed);
        a = { x: fb.x + fb.w, y: fb.y + fb.h / 2 };
        b = { x: tb.x, y: tb.y + tb.h / 2 };
      }
      const p = pointAlong(a, b, pos.t);
      out.push({
        key: pos.token,
        x: p.x,
        y: p.y,
        color: TOKEN_COLORS[pos.token % TOKEN_COLORS.length],
        dwell: false,
      });
    }
    return out;
  }, [trace.hops.length, timelines, playhead, currentPath, compById, edges, anchorsFor, effectiveLayout, fabricGeo]);

  // ---- occupancy / bottlenecks -----------------------------------------------------
  const { nodeOccupancy, congestedIds } = useMemo(() => {
    const perLeaf = occupancyAt(timelines, playhead);
    const perNode = new Map<string, number>();
    for (const [leaf, n] of perLeaf) {
      const vis = ancestorAt(leaf, currentPath);
      if (vis) perNode.set(vis, (perNode.get(vis) ?? 0) + n);
    }
    return { nodeOccupancy: perNode, congestedIds: congestedAt(perNode) };
  }, [timelines, playhead, currentPath]);

  // ---- fabric edges (root level only) — render mapping over fabricGeo ------------
  const fabricEdges = useMemo(
    () =>
      fabricGeo.map((g) => ({
        key: `${g.kind}:${g.aId}|${g.bId}`,
        a: g.a,
        b: g.b,
        kind: g.kind,
        label:
          g.kind === 'attach'
            ? `${g.aId} ⇌ ${g.bId} — fabric attachment (right-click to detach)`
            : `${g.aId} ⇌ ${g.bId} — router trunk (right-click to unlink)`,
        onRemove: () =>
          g.kind === 'attach'
            ? onAttachRouter(g.aId, g.bId, false)
            : onLinkRouters(g.aId, g.bId, false),
      })),
    [fabricGeo, onAttachRouter, onLinkRouters],
  );

  // ---- derived dataflow (ghost edges from forwarding rules, root only) -----------
  const derivedEdges = useMemo(() => {
    if (currentPath !== null || !graph.derived) return [];
    const grouped = new Map<
      string,
      { fromTop: string; toTop: string; router: string; labels: string[]; titles: string[] }
    >();
    for (const d of graph.derived) {
      const key = `${d.fromTop}|${d.toTop}`;
      const range =
        d.addrLo !== undefined || d.addrHi !== undefined
          ? ` [${d.addrLo ?? '0x0'}..${d.addrHi ?? 'max'}]`
          : '';
      const entry = grouped.get(key) ?? {
        fromTop: d.fromTop,
        toTop: d.toTop,
        router: d.router,
        labels: [] as string[],
        titles: [] as string[],
      };
      entry.labels.push(`${d.message ?? '∗'}${range}`);
      entry.titles.push(
        `${d.router} rule ${d.ruleIndex + 1}: ${d.message ?? 'any message'}${range} → ${d.toTop}`,
      );
      grouped.set(key, entry);
    }
    return [...grouped.values()];
  }, [currentPath, graph.derived]);

  // ---- metrics overlay (playhead-aware heat) -------------------------------------
  // Pure derivations from the run trace, re-projected to the visible level —
  // the divergence-projection pattern. Memoized on the INTEGER playhead so
  // heat updates once per cycle, not per animation frame.
  const [metricsOverlay, setMetricsOverlay] = useState(false);
  const cyclePlayhead = Math.floor(playhead);
  const heatOn = metricsOverlay && trace.source === 'run';
  const edgeHeat = useMemo(() => {
    if (!heatOn) return null;
    const projected = new Map<string, number>();
    for (const [key, bw] of linkBandwidthAt(trace.hops, cyclePlayhead)) {
      const [from, to] = key.split('->');
      const vf = ancestorAt(from, currentPath);
      const vt = to ? ancestorAt(to, currentPath) : null;
      if (!vf || !vt || vf === vt) continue;
      const k = `${vf}->${vt}`;
      projected.set(k, (projected.get(k) ?? 0) + bw);
    }
    return projected;
  }, [heatOn, trace.hops, cyclePlayhead, currentPath]);
  const edgeHeatMax = useMemo(
    () => (edgeHeat && edgeHeat.size > 0 ? Math.max(...edgeHeat.values()) : 0),
    [edgeHeat],
  );
  const nodeHeat = useMemo(() => {
    if (!heatOn) return null;
    const projected = new Map<string, number>();
    for (const [comp, depth] of routerDepthTotals(trace.metrics ?? [], cyclePlayhead)) {
      const vis = ancestorAt(comp, currentPath);
      if (vis) projected.set(vis, (projected.get(vis) ?? 0) + depth);
    }
    return projected;
  }, [heatOn, trace.metrics, cyclePlayhead, currentPath]);
  const nodeHeatMax = useMemo(
    () => (nodeHeat && nodeHeat.size > 0 ? Math.max(...nodeHeat.values()) : 0),
    [nodeHeat],
  );

  const divergedIds = useMemo(() => {
    const set = new Set<string>();
    for (const d of divergences) {
      const vis = ancestorAt(d.component, currentPath);
      if (vis) set.add(vis);
    }
    return set;
  }, [divergences, currentPath]);

  // ---- render -----------------------------------------------------------------------
  const worldTransform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`;

  return (
    <div
      ref={pane}
      className={`canvas ${tool === 'hand' || spaceHeld ? 'panning' : ''}`}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDownCapture={onRootDownCapture}
      onPointerDown={onBackgroundDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="world" style={{ transform: worldTransform }}>
        <svg className="wires">
          {fabricEdges.map((fe) => (
            <g key={fe.key} className={`wire wire-fabric wire-fabric-${fe.kind}`}>
              <path
                className="wire-hit"
                d={wirePath(fe.a, fe.b, wireStyle)}
                onPointerDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  fe.onRemove();
                }}
              >
                <title>{fe.label}</title>
              </path>
              <path className="wire-line" d={wirePath(fe.a, fe.b, wireStyle)} />
            </g>
          ))}
          {derivedEdges.map((de) => {
            const fromComp = compById.get(de.fromTop);
            const toComp = compById.get(de.toTop);
            if (!fromComp || !toComp) return null;
            const fb = nodeBox(fromComp, effectiveLayout, collapsed);
            const tb = nodeBox(toComp, effectiveLayout, collapsed);
            const a = { x: fb.x + fb.w, y: fb.y + fb.h / 2 };
            const b = { x: tb.x, y: tb.y + tb.h / 2 };
            const d = wirePath(a, b, wireStyle);
            return (
              <g key={`derived:${de.fromTop}|${de.toTop}`} className="wire wire-derived">
                <path
                  className="wire-hit"
                  d={d}
                  onPointerDown={(e) => {
                    // Derived dataflow is owned by the router's rules — click
                    // selects the router so the inspector opens on them.
                    e.stopPropagation();
                    onSelect({ nodes: new Set([de.router]), wire: null });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <title>
                    {`derived from forwarding rules — click to edit on ${de.router}\n` +
                      de.titles.join('\n')}
                  </title>
                </path>
                <path className="wire-line" d={d} />
                <text
                  className="wire-derived-label"
                  x={(a.x + b.x) / 2}
                  y={(a.y + b.y) / 2 - 6}
                  textAnchor="middle"
                >
                  {de.labels.length === 1 ? de.labels[0] : `${de.labels[0]} +${de.labels.length - 1}`}
                </text>
              </g>
            );
          })}
          {edges.map((edge) => {
            const { a, b } = anchorsFor(edge);
            const d = wirePath(a, b, wireStyle);
            const selected = edge.linkId !== null && selection.wire === edge.linkId;
            const status = edge.status;
            const bw =
              edgeHeat && edge.from && edge.to
                ? (edgeHeat.get(`${edge.from}->${edge.to}`) ?? 0)
                : 0;
            const heat = heatStep(bw, edgeHeatMax);
            return (
              <g
                key={edge.key}
                className={`wire wire-${status} ${selected ? 'wire-selected' : ''} ${heat > 0 ? `wire-heat-${heat}` : ''}`}
              >
                <path
                  className="wire-hit"
                  d={d}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (edge.linkId) onSelect({ nodes: new Set(), wire: edge.linkId });
                  }}
                  onContextMenu={(e) => {
                    // Right-click deletes the wire (single-link edges only).
                    e.preventDefault();
                    e.stopPropagation();
                    if (edge.linkId) onDeleteWire(edge.linkId);
                  }}
                >
                  <title>
                    {edge.count > 1
                      ? `${edge.count} wires`
                      : `${edge.message}${edge.latency !== null ? ` · ${edge.latency}cy` : ''} — right-click to delete`}
                  </title>
                </path>
                <path
                  className="wire-line"
                  d={d}
                  style={heat > 0 ? { strokeWidth: 1 + 3 * (bw / edgeHeatMax) } : undefined}
                />
                {heat > 0 && (
                  <text
                    className="wire-bw"
                    x={(a.x + b.x) / 2}
                    y={(a.y + b.y) / 2 - 18}
                    textAnchor="middle"
                  >
                    {bw.toFixed(2)} pkt/cy
                  </text>
                )}
                {edge.count > 1 && (
                  <text className="wire-count" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6}>
                    ×{edge.count}
                  </text>
                )}
                {edge.via && (
                  <text
                    className="wire-via"
                    x={(a.x + b.x) / 2}
                    y={(a.y + b.y) / 2 + 14}
                    textAnchor="middle"
                  >
                    ⇢ {edge.status === 'routed' ? 'fabric via' : 'via'} {edge.via.join(' → ')}
                  </text>
                )}
                {edge.fabricError && (
                  <text
                    className="wire-fabric-error"
                    x={(a.x + b.x) / 2}
                    y={(a.y + b.y) / 2 + 14}
                    textAnchor="middle"
                  >
                    <title>{edge.fabricError}</title>
                    ⛔ wire not allowed
                  </text>
                )}
                {edge.to === null && edge.status !== 'routed' && (
                  <text className="wire-warn" x={b.x + 6} y={b.y + 4}>
                    {edge.externalLabel ?? `? ${edge.message || 'unresolved'}`}
                  </text>
                )}
                {edge.from === null && (
                  <text className="wire-ext" x={a.x - 6} y={a.y - 6} textAnchor="end">
                    {edge.externalLabel}
                  </text>
                )}
                {selected && edge.message && (
                  <text
                    className="wire-label wire-label-link"
                    x={(a.x + b.x) / 2}
                    y={(a.y + b.y) / 2 - 8}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onRevealEvent(edge.message)}
                  >
                    {edge.message}
                    {edge.latency !== null ? ` · ${edge.latency}cy` : ''}
                  </text>
                )}
              </g>
            );
          })}
          {visibleStubs.map((stub) => {
            const from = compById.get(stub.from);
            if (!from) return null;
            const a = outPortAnchor(from, effectiveLayout, stub.port, collapsed);
            const b = { x: a.x + 70, y: a.y };
            return (
              <g key={`stub:${stub.from}.${stub.port}`} className="wire wire-stub">
                <path className="wire-line" d={wirePath(a, b, wireStyle)} />
                <text className="wire-warn" x={b.x + 6} y={b.y + 4}>
                  ⊥ {stub.message || stub.port}: {stub.reason}
                </text>
              </g>
            );
          })}
          {drag?.kind === 'wire' && drag.current && drag.wireFrom && (() => {
            const from = compById.get(drag.wireFrom.comp);
            if (!from) return null;
            // Dragging from a composite's boundary pin: the pin leaf isn't
            // visible at this level — anchor on its ancestor's pin row.
            if (from.parent !== currentPath) {
              const ancestorId = ancestorAt(from.id, currentPath);
              const ancestor = ancestorId ? compById.get(ancestorId) : undefined;
              const a = ancestor
                ? (compositePinAnchor(ancestor, effectiveLayout, from.id, collapsed) ?? {
                    x: nodeBox(ancestor, effectiveLayout, collapsed).x + NODE_WIDTH,
                    y: nodeBox(ancestor, effectiveLayout, collapsed).y + NODE_HEADER / 2,
                  })
                : drag.current;
              return <path className="wire-draft" d={wirePath(a, drag.current, wireStyle)} />;
            }
            const box = nodeBox(from, effectiveLayout, collapsed);
            const a = drag.wireFrom.port
              ? outPortAnchor(from, effectiveLayout, drag.wireFrom.port, collapsed)
              : { x: box.x + NODE_WIDTH, y: box.y + NODE_HEADER / 2 };
            return <path className="wire-draft" d={wirePath(a, drag.current, wireStyle)} />;
          })()}
        </svg>

        {visible.map((comp) => {
          const b = nodeBox(comp, effectiveLayout, collapsed);
          const isComposite = comp.kind === 'composite';
          const isRouter = comp.kind === 'router';
          const isAuthored = authored.components.has(comp.id);
          const isSelected = selection.nodes.has(comp.id);
          const isIo = comp.io !== undefined || comp.id === 'IO' || comp.id.startsWith('IO.');
          const diverged = divergedIds.has(comp.id);
          const occupants = nodeOccupancy.get(comp.id) ?? 0;
          const congested = congestedIds.has(comp.id);
          const attachedCount = isRouter
            ? (graph.fabric?.attachments.filter((a) => a.router === comp.id).length ?? 0)
            : 0;
          const childCount = isComposite
            ? graph.components.filter((c) => c.parent === comp.id).length
            : 0;
          const inbound = edges.filter((e) => e.to === comp.id);
          const inRows = inRowsOf(comp);
          const wiredInMessages = new Set(inbound.map((e) => e.message));
          const fromByMessage = new Map(
            inbound.map((e) => [e.message, e.from ?? e.externalLabel ?? null]),
          );
          const leafId = comp.id.split('.').pop();
          const renaming = renamingId === comp.id;
          const isFolded = collapsed?.has(comp.id) ?? false;
          return (
            <article
              key={comp.id}
              className={`node ${isComposite ? 'composite' : ''} ${isRouter ? 'router' : ''} ${isIo ? 'io-node' : ''} ${isSelected ? 'selected' : ''} ${diverged ? 'diverged' : ''} ${congested ? 'congested' : ''} ${nodeHeat && (nodeHeat.get(comp.id) ?? 0) > 0 ? `heat-${heatStep(nodeHeat.get(comp.id)!, nodeHeatMax)}` : ''} ${isAuthored || isComposite || isRouter ? '' : 'handwritten'} ${isFolded ? 'folded' : ''}`}
              style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
              onPointerDown={(e) => onNodeDown(e, comp.id)}
              onDoubleClick={() => (isComposite ? onDrillIn(comp.id) : onReveal(comp.id))}
              title={
                isRouter
                  ? `${comp.id} — fabric router (double-click opens src/${comp.id}.cpp — write latency models there)`
                  : isComposite
                    ? `${comp.id} — composite (double-click to open)`
                    : isAuthored
                      ? comp.id
                      : `${comp.id} (hand-written C++)`
              }
            >
              <header className="node-title">
                {onToggleCollapse && (
                  <button
                    className="node-fold"
                    aria-expanded={!isFolded}
                    title={isFolded ? 'Expand this block' : 'Collapse to its header'}
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleCollapse(comp.id);
                    }}
                  >
                    {isFolded ? '▸' : '▾'}
                  </button>
                )}
                {renaming ? (
                  <input
                    className="node-rename"
                    defaultValue={comp.label}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onBlur={(e) => onRenameEnd(comp.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onRenameEnd(comp.id, e.currentTarget.value);
                      if (e.key === 'Escape') onRenameEnd(comp.id, null);
                    }}
                  />
                ) : (
                  <span
                    className="node-label"
                    title="double-click to rename"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      onRenameStart(comp.id);
                    }}
                  >
                    {isComposite ? '▣ ' : ''}
                    {isRouter ? '◈ ' : ''}
                    {isIo && !isComposite ? '⇄ ' : ''}
                    {comp.role === 'trafficgen' ? '⚡ ' : ''}
                    {comp.label}
                  </span>
                )}
                {!renaming && entryIds.has(comp.id) && (
                  <span className="entry-badge" title="simulation entry — seeded at cycle 0">
                    ▶
                  </span>
                )}
                {!renaming && nodeHeat && (nodeHeat.get(comp.id) ?? 0) > 0 && (
                  <span
                    className="depth-chip"
                    title={`${nodeHeat.get(comp.id)} packet(s) queued (engine qdepth)`}
                  >
                    ⧈ {nodeHeat.get(comp.id)}
                  </span>
                )}
                {!renaming && occupants > 1 && (
                  <span
                    className={`occupancy-chip ${congested ? 'hot' : ''}`}
                    title={`${occupants} tokens queued here${congested ? ' — possible bottleneck' : ''}`}
                  >
                    ×{occupants}
                  </span>
                )}
                {!renaming && comp.impl === 'sv' && (
                  <span className="sv-chip" title="SystemVerilog twin selected (lint-checked)">
                    SV
                  </span>
                )}
                {!renaming && comp.label !== leafId && <span className="node-id">{leafId}</span>}
              </header>
              {isFolded ? null : isRouter ? (
                <>
                  <div className="node-body">
                    <div className="port-row" style={{ height: PORT_ROW }}>
                      <span
                        className="port-name"
                        title={`${attachedCount} attached component(s) · per-hop latency ${comp.routerLatency ?? 1} cycle(s)`}
                      >
                        ⧉ {attachedCount} attached · lat {comp.routerLatency ?? 1}
                      </span>
                    </div>
                  </div>
                  <span
                    className="port-dot new-port"
                    title="drag to a top-level component to attach it, or to another router to trunk"
                    onPointerDown={(e) => onPortDown(e, comp.id, null)}
                  >
                    +
                  </span>
                </>
              ) : isComposite ? (
                <>
                  <div className="node-body">
                    {compositePinRows(comp).map((pin) => (
                      <div
                        key={pin.id}
                        className={`port-row ${pin.io === 'in' ? 'in-row' : ''} pin-row`}
                        style={{ height: PORT_ROW }}
                      >
                        {pin.io === 'in' && (
                          <span
                            className="port-dot in wired pin"
                            title={`boundary input ${pin.label}${pin.message ? ` (${pin.message})` : ''}`}
                          />
                        )}
                        <span
                          className="port-name"
                          title={`${pin.label}${pin.message ? ` · ${pin.message}` : ''} — I/O pin ${pin.id}`}
                        >
                          {pin.label}
                          {pin.message ? ' · ' : ''}
                          {pin.message && (
                            <a
                              className="message-link"
                              title={`open ${pin.message}`}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                onRevealEvent(pin.message!);
                              }}
                            >
                              {pin.message}
                            </a>
                          )}
                          {pin.message && (eventFields.get(pin.message)?.length ?? 0) > 0 && (
                            <span
                              className="field-chevron"
                              title={`show ${pin.message} variables`}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => openFieldCard(pin.message!, e)}
                            >
                              ▾
                            </span>
                          )}
                        </span>
                        {pin.io === 'out' && (
                          <span
                            className="port-dot out pin"
                            title={`drag to connect from boundary output ${pin.label}`}
                            onPointerDown={(e) => onPortDown(e, pin.id, null)}
                          />
                        )}
                      </div>
                    ))}
                    {compositePinRows(comp).length === 0 && (
                      <div className="port-row port-row-empty">
                        <span className="port-name">
                          {childCount} block{childCount === 1 ? '' : 's'} inside ⏎
                        </span>
                      </div>
                    )}
                  </div>
                  {childCount > 0 && (
                    <span
                      className="port-dot new-port"
                      title="drag to another block to connect (picks the inner blocks on both ends)"
                      onPointerDown={(e) => onPortDown(e, comp.id, null)}
                    >
                      +
                    </span>
                  )}
                  <div
                    className="composite-add-pins"
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <button
                      title={`add an input pin inside ${comp.label} — shows here as a boundary input`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddPin(comp.id, 'in');
                      }}
                    >
                      + ⇥ in
                    </button>
                    <button
                      title={`add an output pin inside ${comp.label} — shows here as a boundary output`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddPin(comp.id, 'out');
                      }}
                    >
                      + ↦ out
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="node-body">
                    {inRows.map((message) => (
                      <div
                        key={`in:${message}`}
                        className="port-row in-row"
                        style={{ height: PORT_ROW }}
                      >
                        <span
                          className={`port-dot in ${wiredInMessages.has(message) ? 'wired' : ''}`}
                          title={
                            wiredInMessages.has(message)
                              ? `${message} ← ${fromByMessage.get(message) ?? '?'}`
                              : `expects ${message} — no wire yet`
                          }
                        />
                        <span className="port-name">
                          <a
                            className="message-link"
                            title={`open ${message}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              onRevealEvent(message);
                            }}
                          >
                            {message}
                          </a>
                          {(eventFields.get(message)?.length ?? 0) > 0 && (
                            <span
                              className="field-chevron"
                              title={`show ${message} variables`}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => openFieldCard(message, e)}
                            >
                              ▾
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                    {comp.outPorts.map((port) => (
                      <div key={port.name} className="port-row">
                        <span
                          className="port-name"
                          title={`${port.name}${port.message ? ` · ${port.message}` : ''}`}
                        >
                          {port.name}
                          {port.message ? ' · ' : ''}
                          {port.message && (
                            <a
                              className="message-link"
                              title={`open ${port.message}`}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                onRevealEvent(port.message!);
                              }}
                            >
                              {port.message}
                            </a>
                          )}
                          {port.message && (eventFields.get(port.message)?.length ?? 0) > 0 && (
                            <span
                              className="field-chevron"
                              title={`show ${port.message} variables`}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => openFieldCard(port.message!, e)}
                            >
                              ▾
                            </span>
                          )}
                        </span>
                        <span
                          className="port-dot out"
                          title={`drag to connect ${comp.id}.${port.name}`}
                          onPointerDown={(e) => onPortDown(e, comp.id, port.name)}
                        />
                      </div>
                    ))}
                    {inRows.length === 0 && comp.outPorts.length === 0 && (
                      <div className="port-row port-row-empty">
                        <span className="port-name">no ports</span>
                      </div>
                    )}
                    {comp.vars.length > 0 && (
                      <div className="var-section">
                        {comp.vars.map((v) => {
                          const [name, type] = v.split(':');
                          return (
                            <div key={v} className="var-row" style={{ height: VAR_ROW }}>
                              <span className="var-name">{name}</span>
                              <span className="var-type">{type}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <span
                    className="port-dot new-port"
                    title="drag to a block to add a new connection"
                    onPointerDown={(e) => onPortDown(e, comp.id, null)}
                  >
                    +
                  </span>
                </>
              )}
              {(() => {
                if (isFolded) return null;
                // Fallback input pins for wires whose event has no in-row
                // (hand-written mismatch), plus a default drop hint when the
                // block has neither in-rows nor inbound wires.
                if (inRows.length === 0 && inbound.length === 0)
                  return (
                    <span
                      className="port-dot in"
                      style={{ top: NODE_HEADER + (b.h - NODE_HEADER) / 2 }}
                      title="input — drop a wire here"
                    />
                  );
                return inbound
                  .filter((e) => !e.message || !inRows.includes(e.message))
                  .map((e) => {
                    const s = inSlots.get(e.key);
                    const y = inAnchor(comp, effectiveLayout, s?.slot ?? 0, s?.slots ?? 1, collapsed).y - b.y;
                    return (
                      <span
                        key={e.key}
                        className="port-dot in wired"
                        style={{ top: y }}
                        title={`${e.message || 'input'}${e.from ? ` ← ${e.from}` : ` ${e.externalLabel ?? ''}`}`}
                      />
                    );
                  });
              })()}
            </article>
          );
        })}

        <svg className="tokens">
          {tokens.map((tok) => (
            <circle
              key={tok.key}
              className={tok.dwell ? 'token-dwell' : 'token-flight'}
              cx={tok.x}
              cy={tok.y}
              r={tok.dwell ? 5 : 6}
              fill={tok.color}
            />
          ))}
        </svg>

        {drag?.kind === 'marquee' && drag.current && (
          <div
            className="marquee"
            style={{
              left: Math.min(drag.startX, drag.current.x),
              top: Math.min(drag.startY, drag.current.y),
              width: Math.abs(drag.current.x - drag.startX),
              height: Math.abs(drag.current.y - drag.startY),
            }}
          />
        )}
      </div>

      {fieldCard && (
        <div
          className="field-card"
          style={{
            left: Math.min(fieldCard.screenX, window.innerWidth - 240),
            top: fieldCard.screenY + 10,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="fc-title">
            <a className="message-link" onClick={() => onRevealEvent(fieldCard.event)}>
              {fieldCard.event}
            </a>
            <button className="isa-remove" title="close" onClick={() => setFieldCard(null)}>
              ✕
            </button>
          </div>
          {(eventFields.get(fieldCard.event) ?? []).map((f) => {
            const idx = f.indexOf(':');
            return (
              <div key={f} className="fc-field">
                <span className="fc-name">{f.slice(0, idx)}</span>
                <span className="fc-type">{f.slice(idx + 1)}</span>
              </div>
            );
          })}
          {(eventFields.get(fieldCard.event) ?? []).length === 0 && (
            <div className="fc-field dim">no variables</div>
          )}
        </div>
      )}

      {connectDraft && (
        <ConnectForm
          draft={connectDraft}
          graph={graph}
          onConfirm={(from, to, message, isNew, latency) => {
            onConnect(from, to, message, isNew, latency);
            setConnectDraft(null);
          }}
          onCancel={() => setConnectDraft(null)}
        />
      )}

      {ruleDraft && (
        <RuleForm
          draft={ruleDraft}
          graph={graph}
          onConfirm={(router, rule) => {
            onAddRule(router, rule);
            setRuleDraft(null);
          }}
          onCancel={() => setRuleDraft(null)}
        />
      )}

      {trace.source === 'run' && (
        <button
          className={`metrics-toggle ${metricsOverlay ? 'on' : ''}`}
          title="overlay per-link bandwidth and router queue depth from the last run"
          onClick={() => setMetricsOverlay((v) => !v)}
        >
          ▦ metrics
        </button>
      )}
      <div className="zoom-badge">{Math.round(camera.z * 100)}%</div>
    </div>
  );
}

function ConnectForm(props: {
  draft: ConnectDraft;
  graph: Graph;
  onConfirm(from: string, to: string, message: string, isNewEvent: boolean, latency: number): void;
  onCancel(): void;
}) {
  const { draft, graph, onConfirm, onCancel } = props;
  const sourceComp = graph.components.find((c) => c.id === draft.from);
  const targetComp = graph.components.find((c) => c.id === draft.to);
  const isCompositeSource = sourceComp?.kind === 'composite';
  const isCompositeTarget = targetComp?.kind === 'composite';
  // Wires terminate on leaves — a composite endpoint (either side) offers its
  // inner leaves, so composite ⇄ composite connections read as boundary I/O.
  // When the composite declares I/O pins, ONLY the matching pins are offered:
  // pins are its interface; bypassing them defeats the boundary.
  const leavesUnder = (id: string, pinDirection: 'in' | 'out') => {
    const all = graph.components.filter((c) => c.kind === 'leaf' && c.id.startsWith(`${id}.`));
    const pins = all.filter((c) => c.io === pinDirection);
    return pins.length > 0 ? pins : all;
  };
  const innerFromLeaves = useMemo(
    () => (isCompositeSource ? leavesUnder(draft.from, 'out') : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.components, draft.from, isCompositeSource],
  );
  const innerLeaves = useMemo(
    () => (isCompositeTarget ? leavesUnder(draft.to, 'in') : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.components, draft.to, isCompositeTarget],
  );
  const [innerFrom, setInnerFrom] = useState<string>(innerFromLeaves[0]?.id ?? '');
  const [innerTo, setInnerTo] = useState<string>(innerLeaves[0]?.id ?? '');

  const resolvedFrom = isCompositeSource ? innerFrom : draft.from;
  const resolvedTo = isCompositeTarget ? innerTo : draft.to;

  const suggested = `${resolvedFrom.split('.').pop() || 'X'}To${resolvedTo.split('.').pop() || 'X'}Event`;
  const [choice, setChoice] = useState<string>('__new__');
  const [newName, setNewName] = useState(suggested);
  const [touched, setTouched] = useState(false);
  const [latency, setLatency] = useState(1);

  const effectiveName = touched ? newName : suggested;

  const confirm = () => {
    if (!resolvedFrom || !resolvedTo) return;
    if (choice === '__new__') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(effectiveName)) return;
      onConfirm(
        resolvedFrom,
        resolvedTo,
        effectiveName,
        !graph.events.some((e) => e.id === effectiveName),
        latency,
      );
    } else {
      onConfirm(resolvedFrom, resolvedTo, choice, false, latency);
    }
  };

  return (
    <div
      className="connect-form"
      style={{ left: Math.min(draft.screenX, window.innerWidth - 280), top: draft.screenY }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="cf-title" title={`${resolvedFrom || draft.from} → ${resolvedTo || draft.to}`}>
        {resolvedFrom || draft.from} → {resolvedTo || draft.to}
      </div>
      {isCompositeSource && (
        <label>
          from
          <select value={innerFrom} onChange={(e) => setInnerFrom(e.target.value)}>
            {innerFromLeaves.map((c) => (
              <option key={c.id} value={c.id}>
                {c.io ? `↦ ${c.label} — ${c.id}` : c.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {isCompositeTarget && (
        <label>
          into
          <select value={innerTo} onChange={(e) => setInnerTo(e.target.value)}>
            {innerLeaves.map((c) => (
              <option key={c.id} value={c.id}>
                {c.io ? `⇥ ${c.label} — ${c.id}` : c.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        message
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="__new__">new event…</option>
          {graph.events.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.id}
            </option>
          ))}
        </select>
      </label>
      {choice === '__new__' && (
        <label>
          name
          <input
            value={effectiveName}
            autoFocus
            onChange={(e) => {
              setTouched(true);
              setNewName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm();
              if (e.key === 'Escape') onCancel();
            }}
          />
        </label>
      )}
      <label>
        latency
        <input
          type="number"
          min={0}
          value={latency}
          onChange={(e) => setLatency(Math.max(0, Number(e.target.value) || 0))}
        />
      </label>
      <div className="cf-actions">
        <button onClick={confirm} disabled={(isCompositeTarget && !innerTo) || (isCompositeSource && !innerFrom)}>
          Connect
        </button>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Cross-top drag popover: authors ONE forwarding rule on a router attached
 *  to the source top. Dataflow between top-level units is rule-authored —
 *  this keeps the familiar connect gesture as the way in. */
function RuleForm(props: {
  draft: RuleDraft;
  graph: Graph;
  onConfirm(router: string, rule: ForwardingRule): void;
  onCancel(): void;
}) {
  const { draft, graph, onConfirm, onCancel } = props;
  // Routers the SOURCE top attaches to — rules resolve at the ingress.
  const routers = useMemo(
    () =>
      (graph.fabric?.attachments ?? [])
        .filter((a) => a.component === draft.from)
        .map((a) => a.router)
        .sort(),
    [graph.fabric, draft.from],
  );
  // Messages statically leaving the source top (its routed links + stubs) —
  // the natural preselection for the rule's message dimension.
  const outboundMessages = useMemo(() => {
    const topOf = (id: string) => (id.includes('.') ? id.slice(0, id.indexOf('.')) : id);
    const messages = new Set<string>();
    for (const l of graph.links)
      if (l.status === 'routed' && topOf(l.from) === draft.from && l.message) messages.add(l.message);
    for (const s of graph.stubs)
      if (topOf(s.from) === draft.from && s.message) messages.add(s.message);
    return [...messages].sort();
  }, [graph.links, graph.stubs, draft.from]);

  const [router, setRouter] = useState<string>(routers[0] ?? '');
  const [message, setMessage] = useState<string>(
    outboundMessages.length === 1 ? outboundMessages[0] : '',
  );
  const [addrLo, setAddrLo] = useState('');
  const [addrHi, setAddrHi] = useState('');

  const loOk = addrLo.trim() === '' || parseAddr(addrLo) !== null;
  const hiOk = addrHi.trim() === '' || parseAddr(addrHi) !== null;
  const rangeOk =
    loOk &&
    hiOk &&
    (addrLo.trim() === '' || addrHi.trim() === '' || parseAddr(addrLo)! <= parseAddr(addrHi)!);
  const canConfirm = router !== '' && rangeOk;

  const confirm = () => {
    if (!canConfirm) return;
    onConfirm(router, {
      ...(message !== '' ? { message } : {}),
      ...(addrLo.trim() !== '' ? { addrLo: addrLo.trim() } : {}),
      ...(addrHi.trim() !== '' ? { addrHi: addrHi.trim() } : {}),
      to: draft.to,
    });
  };

  return (
    <div
      className="connect-form"
      style={{ left: Math.min(draft.screenX, window.innerWidth - 280), top: draft.screenY }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="cf-title" title={`forwarding rule: ${draft.from} → ${draft.to}`}>
        ⇢ rule: {draft.from} → {draft.to}
      </div>
      <div className="cf-note">
        Dataflow between top-level units rides the fabric — this drag authors a
        forwarding rule, not a wire.
      </div>
      {routers.length === 0 ? (
        <div className="cf-note cf-warn">
          {draft.from} is not attached to a router — drag it onto a ◈ router first, then draw
          this again.
        </div>
      ) : (
        <>
          <label>
            router
            <select value={router} onChange={(e) => setRouter(e.target.value)}>
              {routers.map((r) => (
                <option key={r} value={r}>
                  ◈ {r}
                </option>
              ))}
            </select>
          </label>
          <label>
            message
            <select value={message} onChange={(e) => setMessage(e.target.value)}>
              <option value="">(any message)</option>
              {graph.events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            addr lo
            <input
              className={loOk ? '' : 'cf-invalid'}
              placeholder="0x0 (optional)"
              value={addrLo}
              onChange={(e) => setAddrLo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm();
                if (e.key === 'Escape') onCancel();
              }}
            />
          </label>
          <label>
            addr hi
            <input
              className={hiOk ? '' : 'cf-invalid'}
              placeholder="max (optional)"
              value={addrHi}
              onChange={(e) => setAddrHi(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm();
                if (e.key === 'Escape') onCancel();
              }}
            />
          </label>
        </>
      )}
      <div className="cf-actions">
        <button onClick={confirm} disabled={!canConfirm}>
          Add rule
        </button>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
