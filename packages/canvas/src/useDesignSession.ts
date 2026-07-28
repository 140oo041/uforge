// The design session: all of the canvas's state and every operation on it,
// with no opinion about how it is laid out.
//
// This exists because the two hosts want genuinely different shells. Inside VS
// Code the surface should read as part of the editor, so `App` keeps the
// familiar rails-and-dock arrangement. The standalone app has no editor to
// belong to, and a mini-IDE floating inside a window is just chrome — so it
// composes the same pieces into a full-bleed bench instead.
//
// Both get identical behaviour, because behaviour lives here, once.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EMPTY_GRAPH, type Graph } from '@iss/contracts/graph';
import {
  leafName,
  type ComponentKind,
  type EditIntent,
  type ForwardingRule,
  type IoDirection,
} from '@iss/contracts/model';
import type { HostMsg, LayoutMap, RunStatus, SailStatus } from '@iss/contracts/messaging';
import { DEFAULT_RUN_CONFIG, type RunConfig } from '@iss/contracts/runConfig';
import type { SpecDocument } from '@iss/contracts/spec';
import { EMPTY_TRACE, tickStride, type Trace } from '@iss/contracts/trace';
import type { WaveDoc } from '@iss/contracts/waves';
import { autoLayout, entryBlocksOf, levelEdges, snap, visibleComponents } from './layout';
import type { Selection } from './canvas';
import type { WireStyle } from './layout';
import type { EditorTab } from './shell';
import { useTransport } from './transport';

export interface UndoEntry {
  undo: () => void;
  redo: () => void;
}

export interface Authored {
  components: Set<string>;
  events: Set<string>;
}

/** Everything a shell needs. Consumed by both the IDE shell and the bench. */
export type DesignSession = ReturnType<typeof useDesignSession>;

export function useDesignSession() {
  const { post, subscribe } = useTransport();
  const [graph, setGraph] = useState<Graph>(EMPTY_GRAPH);
  const [layout, setLayout] = useState<LayoutMap>({});
  const [authored, setAuthored] = useState<Authored>({
    components: new Set(),
    events: new Set(),
  });
  const [selection, setSelection] = useState<Selection>({ nodes: new Set(), wire: null });
  const [tool, setTool] = useState<'select' | 'hand'>('select');
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace>(EMPTY_TRACE);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const [runStatus, setRunStatus] = useState<RunStatus>({ phase: 'idle' });
  const [sail, setSail] = useState<SailStatus | null>(null);
  const [spec, setSpec] = useState<SpecDocument | null>(null);
  const [activeTab, setActiveTab] = useState<EditorTab>('design');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [runConfig, setRunConfig] = useState<RunConfig>(DEFAULT_RUN_CONFIG);
  const [showRunConfig, setShowRunConfig] = useState(false);
  const [waves, setWaves] = useState<WaveDoc[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [zoomTick, bumpZoom] = useState(0);
  /** Curvy reads well when edges fan out; square is how silicon actually
   *  routes and is easier to follow down a parallel pipeline. */
  const [wireStyle, setWireStyle] = useState<WireStyle>('curvy');
  /** Blocks folded to their header. Purely a view concern — never persisted
   *  into the design, because it says nothing about the design. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const pathRef = useRef(currentPath);
  pathRef.current = currentPath;

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const sendEdit = useCallback(
    (intent: EditIntent) => {
      post({ type: 'edit', intent });
    },
    [post],
  );

  const pushUndo = useCallback((entry: UndoEntry) => {
    undoStack.current.push(entry);
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
  }, []);

  const persistLayout = useCallback(
    (next: LayoutMap) => {
      setLayout(next);
      post({ type: 'saveLayout', layout: next });
    },
    [post],
  );

  // ---- host messages ---------------------------------------------------------
  useEffect(() => {
    const onMessage = (msg: HostMsg) => {
      switch (msg.type) {
        case 'graph': {
          setGraph(msg.graph);
          // Place any node the layout doesn't know yet — per drill level so
          // siblings lay out together; user positions stay.
          setLayout((prev) => {
            const missing = msg.graph.components.filter((c) => !prev[c.id]);
            if (missing.length === 0) return prev;
            const next = { ...prev };
            const levels = [...new Set(missing.map((c) => c.parent))];
            for (const level of levels) {
              const visible = visibleComponents(msg.graph, level);
              const auto = autoLayout(visible, levelEdges(msg.graph, level));
              let maxY = visible.reduce((m, c) => Math.max(m, prev[c.id]?.y ?? 0), 0);
              for (const comp of missing.filter((c) => c.parent === level)) {
                next[comp.id] = auto[comp.id] ?? { x: 40, y: snap(maxY + 96) };
                if (!auto[comp.id]) maxY += 96;
              }
            }
            return next;
          });
          break;
        }
        case 'layout':
          // The saved file WINS over anything already in state. It used to be
          // the other way round, and because 'graph' arrives first and
          // auto-places every unknown node, those throwaway positions became
          // `prev` and the user's real layout was discarded on every open —
          // blocks appeared to reset their position every time.
          setLayout((prev) => ({ ...prev, ...msg.layout }));
          break;
        case 'selection': {
          const id = msg.id;
          setSelection({ nodes: new Set(id ? [id] : []), wire: null });
          if (id) {
            // Navigate to the level where the block lives.
            const comp = graphRef.current.components.find((c) => c.id === id);
            if (comp) setCurrentPath(comp.parent);
          }
          break;
        }
        case 'authored':
          setAuthored({
            components: new Set(msg.components),
            events: new Set(msg.events),
          });
          break;
        case 'editError':
          showToast(msg.message);
          break;
        case 'trace':
          setTrace(msg.trace);
          setPlayhead(0);
          setPlaying(msg.trace.hops.length > 0);
          break;
        case 'runlog':
          if (msg.clear) setConsoleLines([]);
          if (msg.line !== undefined) setConsoleLines((prev) => [...prev.slice(-499), msg.line!]);
          if (msg.status) setRunStatus(msg.status);
          break;
        case 'sail':
          setSail(msg.status);
          break;
        case 'spec':
          setSpec(msg.spec);
          break;
        case 'runConfig':
          setRunConfig(msg.config);
          break;
        case 'waves':
          setWaves(msg.waves);
          break;
      }
    };
    const unsubscribe = subscribe(onMessage);
    post({ type: 'ready' });
    return unsubscribe;
  }, [showToast, post, subscribe]);

  // ---- playback clock ---------------------------------------------------------
  useEffect(() => {
    if (!playing || trace.ticks === 0) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setPlayhead((prev) => {
        // 2.5 reference CYCLES per second — the playhead is in ticks, and at a
        // fine timebase 2.5 ticks/s would look motionless.
        const next = prev + dt * 2.5 * speed * tickStride(trace);
        if (next >= trace.ticks) {
          setPlaying(false);
          return trace.ticks;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, trace.ticks, trace]);

  // ---- edit operations (with undo) ------------------------------------------
  const idTaken = useCallback(
    (id: string): boolean =>
      graphRef.current.components.some((c) => c.id === id) ||
      graphRef.current.events.some((e) => e.id === id) ||
      authored.components.has(id) ||
      authored.events.has(id),
    [authored],
  );

  const uniqueChildIdUnder = useCallback(
    (parentId: string | null, prefix: string): string => {
      const base = parentId ? `${parentId}.` : '';
      for (let n = 1; ; n++) {
        const id = `${base}${prefix}${n}`;
        if (!idTaken(id)) return id;
      }
    },
    [idTaken],
  );

  const uniqueChildId = useCallback(
    (prefix: string): string => uniqueChildIdUnder(pathRef.current, prefix),
    [uniqueChildIdUnder],
  );

  const placeBlock = useCallback(
    (
      id: string,
      x: number,
      y: number,
      nodeKind: ComponentKind,
      io?: IoDirection,
      role?: 'trafficgen',
    ) => {
      if (nodeKind === 'router' && pathRef.current !== null) {
        showToast('routers live at the top level — press Escape to drill out first');
        return;
      }
      sendEdit({ kind: 'addComponent', id, nodeKind, io, role });
      const nextLayout = { ...layoutRef.current, [id]: { x: snap(x), y: snap(y) } };
      persistLayout(nextLayout);
      setSelection({ nodes: new Set([id]), wire: null });
      pushUndo({
        undo: () => sendEdit({ kind: 'removeComponent', id }),
        redo: () => {
          sendEdit({ kind: 'addComponent', id, nodeKind, io, role });
          persistLayout({ ...layoutRef.current, [id]: { x: snap(x), y: snap(y) } });
        },
      });
    },
    [sendEdit, persistLayout, pushUndo, showToast],
  );

  const addBlockAt = useCallback(
    (
      prefix: string,
      x: number,
      y: number,
      nodeKind: ComponentKind = 'leaf',
      io?: IoDirection,
      role?: 'trafficgen',
    ) => placeBlock(uniqueChildId(prefix), x, y, nodeKind, io, role),
    [placeBlock, uniqueChildId],
  );

  /** Create a block with an exact user-chosen class name (palette form). */
  const addNamedBlock = useCallback(
    (name: string, nodeKind: ComponentKind = 'leaf') => {
      const id = pathRef.current ? `${pathRef.current}.${name}` : name;
      if (idTaken(id)) {
        showToast(`'${id}' already exists`);
        return;
      }
      const visible = visibleComponents(graphRef.current, pathRef.current);
      const maxY = visible.reduce((m, c) => Math.max(m, layoutRef.current[c.id]?.y ?? 0), 0);
      placeBlock(id, 80, maxY + 120, nodeKind);
    },
    [idTaken, showToast, placeBlock],
  );

  /** Add a boundary I/O pin directly inside a composite viewed from outside —
   *  same intent as dropping an In/Out template while drilled in, but targeted
   *  at an explicit composite instead of the current drill path. */
  const addPinToComposite = useCallback(
    (compositeId: string, io: IoDirection) => {
      const id = uniqueChildIdUnder(compositeId, io === 'in' ? 'In' : 'Out');
      // Place among the composite's existing children so a later drill-in
      // finds the pin somewhere sensible (inputs left, outputs right).
      const inside = visibleComponents(graphRef.current, compositeId);
      const maxY = inside.reduce((m, c) => Math.max(m, layoutRef.current[c.id]?.y ?? 0), 0);
      placeBlock(id, io === 'in' ? 80 : 480, maxY + 120, 'leaf', io);
    },
    [uniqueChildIdUnder, placeBlock],
  );

  const duplicateBlock = useCallback(
    (id: string) => {
      const base = id.replace(/\d+$/, '') || id;
      let newId = '';
      for (let n = 1; ; n++) {
        const candidate = `${base}${n}`;
        if (candidate !== id && !idTaken(candidate)) {
          newId = candidate;
          break;
        }
      }
      sendEdit({ kind: 'duplicateComponent', id, newId });
      const pos = layoutRef.current[id] ?? { x: 40, y: 40 };
      persistLayout({ ...layoutRef.current, [newId]: { x: pos.x + 60, y: pos.y + 60 } });
      setSelection({ nodes: new Set([newId]), wire: null });
      pushUndo({
        undo: () => sendEdit({ kind: 'removeComponent', id: newId }),
        redo: () => sendEdit({ kind: 'duplicateComponent', id, newId }),
      });
    },
    [idTaken, sendEdit, persistLayout, pushUndo],
  );

  /**
   * COPY / PASTE — duplicate, but across drill levels and selections.
   *
   * The clipboard holds ids, not snapshots: `duplicateComponent` already knows
   * how to deep-copy a subtree and remap the wires that stay inside it, so
   * paste is "duplicate each copied id, under wherever we are now". Ids are
   * kept rather than component objects so a paste after an edit copies what the
   * block *is now*, which is what anyone who edits between ⌘C and ⌘V expects.
   *
   * Relative geometry survives: every block keeps its own position shifted by
   * one fixed offset, so pasting a row of four stages gives back a row, not a
   * pile.
   */
  const clipboardRef = useRef<string[]>([]);

  const copySelection = useCallback(() => {
    // Nested picks would be copied twice — duplicateComponent already brings
    // the whole subtree, so drop any id that lives under another copied id.
    const ids = [...selection.nodes].filter((id) => graphRef.current.components.some((c) => c.id === id));
    const roots = ids.filter((id) => !ids.some((other) => other !== id && id.startsWith(`${other}.`)));
    if (roots.length === 0) return;
    clipboardRef.current = roots;
    showToast(`copied ${roots.length === 1 ? roots[0] : `${roots.length} blocks`}`);
  }, [selection.nodes, showToast]);

  const pasteClipboard = useCallback(() => {
    const sources = clipboardRef.current.filter((id) =>
      graphRef.current.components.some((c) => c.id === id),
    );
    if (sources.length === 0) return;
    const parent = pathRef.current;

    // Pasting a composite into itself would ask the model to nest a copy under
    // its own original — refuse here rather than let the edit throw.
    const cyclic = sources.filter((id) => parent === id || parent?.startsWith(`${id}.`));
    if (cyclic.length > 0) {
      showToast(`can't paste ${cyclic[0]} inside itself — drill out first`);
      return;
    }

    const pasted: Array<{ source: string; newId: string }> = [];
    let nextLayout = { ...layoutRef.current };
    for (const source of sources) {
      const prefix = leafName(source).replace(/\d+$/, '') || leafName(source);
      // uniqueChildIdUnder consults the live graph, but the ids minted in this
      // same loop are not in it yet — skip past them explicitly.
      let newId = uniqueChildIdUnder(parent, prefix);
      while (pasted.some((p) => p.newId === newId || newId.startsWith(`${p.newId}.`)))
        newId = uniqueChildIdUnder(parent, `${prefix}_`);
      if (newId === source || newId.startsWith(`${source}.`)) continue;
      sendEdit({ kind: 'duplicateComponent', id: source, newId });
      const pos = layoutRef.current[source] ?? { x: 40, y: 40 };
      nextLayout = { ...nextLayout, [newId]: { x: snap(pos.x + 60), y: snap(pos.y + 60) } };
      pasted.push({ source, newId });
    }
    if (pasted.length === 0) return;
    persistLayout(nextLayout);
    setSelection({ nodes: new Set(pasted.map((p) => p.newId)), wire: null });
    pushUndo({
      undo: () => {
        for (const p of pasted) sendEdit({ kind: 'removeComponent', id: p.newId });
      },
      redo: () => {
        for (const p of pasted) sendEdit({ kind: 'duplicateComponent', id: p.source, newId: p.newId });
        persistLayout(nextLayout);
      },
    });
  }, [uniqueChildIdUnder, sendEdit, persistLayout, pushUndo, showToast]);

  const connect = useCallback(
    (from: string, to: string, message: string, isNewEvent: boolean, latency: number) => {
      // Hard cutover: wires never cross top-level components — that dataflow
      // is authored as forwarding rules on a router (the canvas opens the
      // rule form for root-level drags; this guards every other path).
      const topOf = (id: string) => (id.includes('.') ? id.slice(0, id.indexOf('.')) : id);
      if (to && topOf(from) !== topOf(to)) {
        showToast(
          `${from} and ${to} live under different top-level components — author a forwarding rule on a ◈ router instead of a wire`,
        );
        return;
      }
      // Fan-out: every drawn wire is a fresh out-port, named by its endpoints
      // (out_IF_to_DE) — ids are stable C++ identifiers, labels are not.
      const port = (() => {
        const comp = graphRef.current.components.find((c) => c.id === from);
        const used = new Set([
          ...(comp?.outPorts.map((p) => p.name) ?? []),
          ...(comp?.vars.map((v) => v.split(':')[0]) ?? []),
        ]);
        const base = to ? `out_${leafName(from)}_to_${leafName(to)}` : `out_${leafName(from)}`;
        if (!used.has(base)) return base;
        for (let n = 2; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
      })();
      if (isNewEvent) sendEdit({ kind: 'addEvent', id: message });
      sendEdit({ kind: 'addWire', from, port, message, to, latency });
      pushUndo({
        undo: () => {
          sendEdit({ kind: 'deleteWire', from, port });
          if (isNewEvent) sendEdit({ kind: 'removeEvent', id: message });
        },
        redo: () => {
          if (isNewEvent) sendEdit({ kind: 'addEvent', id: message });
          sendEdit({ kind: 'addWire', from, port, message, to, latency });
        },
      });
    },
    [sendEdit, pushUndo, showToast],
  );

  /** Author one forwarding rule on a router (undo-able). Appended at the end
   *  of the router's ordered list; undo removes that index. */
  const addRule = useCallback(
    (router: string, rule: ForwardingRule) => {
      const index =
        graphRef.current.components.find((c) => c.id === router)?.rules?.length ?? 0;
      sendEdit({ kind: 'addForwardingRule', router, rule });
      pushUndo({
        undo: () => sendEdit({ kind: 'removeForwardingRule', router, index }),
        redo: () => sendEdit({ kind: 'addForwardingRule', router, rule, index }),
      });
    },
    [sendEdit, pushUndo],
  );

  /** Fabric: attach/detach a top-level component to/from one router (undo-able).
   *  A component may attach to several routers, so each toggle names its router. */
  const attachRouter = useCallback(
    (component: string, router: string, attach: boolean) => {
      const already = (graphRef.current.fabric?.attachments ?? []).some(
        (a) => a.component === component && a.router === router,
      );
      if (already === attach) return;
      sendEdit({ kind: 'attachRouter', id: component, router, attach });
      pushUndo({
        undo: () => sendEdit({ kind: 'attachRouter', id: component, router, attach: !attach }),
        redo: () => sendEdit({ kind: 'attachRouter', id: component, router, attach }),
      });
    },
    [sendEdit, pushUndo],
  );

  /** Fabric: connect/disconnect a router↔router trunk (undo-able). */
  const linkRouters = useCallback(
    (a: string, b: string, connectTrunk: boolean) => {
      sendEdit({ kind: 'linkRouters', a, b, connect: connectTrunk });
      pushUndo({
        undo: () => sendEdit({ kind: 'linkRouters', a, b, connect: !connectTrunk }),
        redo: () => sendEdit({ kind: 'linkRouters', a, b, connect: connectTrunk }),
      });
    },
    [sendEdit, pushUndo],
  );

  /** Rename = display label only; the class id / file / engine identity stay fixed. */
  const startRename = useCallback(
    (id: string) => {
      if (!authored.components.has(id)) {
        showToast(`'${id}' is hand-written — edit its source instead`);
        return;
      }
      setRenamingId(id);
    },
    [authored, showToast],
  );

  const endRename = useCallback(
    (id: string, label: string | null) => {
      setRenamingId(null);
      if (label === null) return;
      const comp = graphRef.current.components.find((c) => c.id === id);
      const prev = comp?.label ?? leafName(id);
      const next = label.trim();
      if (!next || next === prev) return;
      sendEdit({ kind: 'renameComponent', id, label: next });
      pushUndo({
        undo: () => sendEdit({ kind: 'renameComponent', id, label: prev }),
        redo: () => sendEdit({ kind: 'renameComponent', id, label: next }),
      });
    },
    [sendEdit, pushUndo],
  );

  /** Delete one wire by link id (works from selection, inspector, or right-click). */
  const deleteWireById = useCallback(
    (linkId: string) => {
      const link = graphRef.current.links.find((l) => l.id === linkId);
      if (!link) return;
      if (!authored.components.has(link.from)) {
        showToast(`'${link.from}' is hand-written — edit its source instead`);
        return;
      }
      const snapshot = { ...link };
      sendEdit({ kind: 'deleteWire', from: link.from, port: link.fromPort });
      pushUndo({
        undo: () =>
          sendEdit({
            kind: 'addWire',
            from: snapshot.from,
            port: snapshot.fromPort,
            message: snapshot.message,
            to: snapshot.to,
            latency: snapshot.latency,
          }),
        redo: () => sendEdit({ kind: 'deleteWire', from: snapshot.from, port: snapshot.fromPort }),
      });
      setSelection((prev) => (prev.wire === linkId ? { nodes: new Set(), wire: null } : prev));
    },
    [authored, sendEdit, pushUndo, showToast],
  );

  const deleteSelection = useCallback(() => {
    const { nodes, wire } = selection;
    if (wire) {
      deleteWireById(wire);
      return;
    }
    for (const id of nodes) {
      if (!authored.components.has(id)) {
        showToast(`'${id}' is hand-written — edit its source instead`);
        continue;
      }
      const comp = graphRef.current.components.find((c) => c.id === id);
      sendEdit({ kind: 'removeComponent', id });
      pushUndo({
        undo: () => {
          sendEdit({ kind: 'addComponent', id, label: comp?.label, nodeKind: comp?.kind });
          for (const p of comp?.outPorts ?? []) {
            const link = graphRef.current.links.find(
              (l) => l.from === id && l.fromPort === p.name,
            );
            if (p.message)
              sendEdit({
                kind: 'addWire',
                from: id,
                port: p.name,
                message: p.message,
                to: link?.to ?? null,
                latency: p.latency,
              });
          }
        },
        redo: () => sendEdit({ kind: 'removeComponent', id }),
      });
    }
    setSelection({ nodes: new Set(), wire: null });
  }, [selection, authored, sendEdit, pushUndo, showToast, deleteWireById]);

  const undo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    entry.undo();
    redoStack.current.push(entry);
  }, []);
  const redo = useCallback(() => {
    const entry = redoStack.current.pop();
    if (!entry) return;
    entry.redo();
    undoStack.current.push(entry);
  }, []);

  // ---- keyboard ----------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copySelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        pasteClipboard();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === 'F2') {
        e.preventDefault();
        const [only] = selection.nodes;
        if (selection.nodes.size === 1 && only) startRename(only);
      } else if (e.key === 'Escape' && pathRef.current !== null) {
        // Escape drills out one level.
        const parent = pathRef.current.includes('.')
          ? pathRef.current.slice(0, pathRef.current.lastIndexOf('.'))
          : null;
        setCurrentPath(parent);
        setSelection({ nodes: new Set(), wire: null });
      } else if (e.key === 'v') setTool('select');
      else if (e.key === 'h') setTool('hand');
      else if (e.key === ' ') setPlaying((p) => trace.ticks > 0 && !p);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    undo,
    redo,
    deleteSelection,
    trace.ticks,
    selection.nodes,
    startRename,
    copySelection,
    pasteClipboard,
  ]);

  const applyAutoLayout = useCallback(() => {
    const before = { ...layoutRef.current };
    const visible = visibleComponents(graphRef.current, pathRef.current);
    const auto = autoLayout(visible, levelEdges(graphRef.current, pathRef.current));
    const next = { ...layoutRef.current, ...auto };
    persistLayout(next);
    pushUndo({ undo: () => persistLayout(before), redo: () => persistLayout(next) });
    bumpZoom((t) => t + 1);
  }, [persistLayout, pushUndo]);

  const activeDivergences = useMemo(
    () => trace.divergences.filter((d) => playhead >= d.cycle),
    [trace.divergences, playhead],
  );

  const entryIds = useMemo(
    () => entryBlocksOf(graph, runConfig.entries),
    [graph, runConfig.entries],
  );

  const breadcrumb = useMemo(() => {
    const parts: Array<{ label: string; path: string | null }> = [
      { label: 'design', path: null },
    ];
    if (currentPath) {
      const segments = currentPath.split('.');
      for (let i = 0; i < segments.length; i++) {
        const path = segments.slice(0, i + 1).join('.');
        // Show the display label when the composite has one.
        const comp = graph.components.find((c) => c.id === path);
        parts.push({ label: comp?.label ?? segments[i], path });
      }
    }
    return parts;
  }, [currentPath, graph.components]);

  const design = activeTab === 'design';

  return {
    post,
    sendEdit,
    graph, layout, authored, spec, trace, waves, runConfig, runStatus, sail,
    selection, setSelection, tool, setTool, currentPath, setCurrentPath,
    activeTab, setActiveTab, panelCollapsed, setPanelCollapsed,
    showRunConfig, setShowRunConfig, renamingId, toast, design,
    zoomTick, bumpZoom, breadcrumb, entryIds, activeDivergences,
    wireStyle, setWireStyle, collapsed, toggleCollapsed,
    playhead, setPlayhead, playing, setPlaying, speed, setSpeed, consoleLines,
    layoutRef, graphRef,
    persistLayout, pushUndo, undo, redo, applyAutoLayout,
    addBlockAt, addNamedBlock, addPinToComposite, duplicateBlock,
    copySelection, pasteClipboard,
    connect, addRule, attachRouter, linkRouters,
    startRename, endRename, deleteWireById, deleteSelection,
    setRunConfig, showToast,
  };
}
