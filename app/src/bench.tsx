// THE SHELL — panes, a command centre, and a scope row.
//
// An earlier pass stripped this app down to one bar and a full-bleed canvas,
// on the theory that IDE chrome is what made it feel a decade old. That was the
// wrong diagnosis. The structure was never the problem — the *rendition* was:
// grey slabs welded edge to edge, hard borders, no hierarchy between regions.
// Modern tools in this space keep the structure and fix the rendition: panes as
// separate surfaces with gaps, a command centre in the title bar, a scope row of
// live filter chips, breadcrumbs inside the pane they describe, and floating
// controls over the canvas.
//
// So the chrome is back, and it earns its space by carrying real content:
//
//   title bar   project, a command centre that searches blocks AND commands,
//               run state, cosmetic mode
//   scope row   Bench/Spec, live custody counts that filter the canvas, drill
//               level and overlay selects
//   list pane   every block at this level, or every problem — the surface that
//               was previously a wall of palette cards carrying nothing
//   canvas pane its own header (breadcrumb) and its own floating controls
//   detail      the inspector, still only when there is a selection
//   ledger      the dock, still a strip that opens on evidence
//
// All state comes from @iss/canvas's useDesignSession(); this file is layout.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  BottomPanel,
  Canvas,
  EventsView,
  Inspector,
  RunConfigPanel,
  SpecDesigner,
  TransportProvider,
  useDesignSession,
  type HostTransport,
} from '@iss/canvas';
import type { ComponentKind } from '@iss/contracts/model';

import { TEMPLATES } from '@iss/canvas/templates';
import { SKINS, applySkin, loadSkin, type SkinId } from './skin';


type Session = ReturnType<typeof useDesignSession>;
type ListTab = 'blocks' | 'problems' | 'events';

/**
 * MOVABLE PANES.
 *
 * Collapsing and resizing were the easy half; a pane you cannot move is still
 * the layout someone else chose for you. Each pane's header is a drag handle,
 * and dropping one on another swaps their slots — so an inspector can sit on
 * the left next to the tree, or the hierarchy can move to the right hand.
 *
 * Order persists in localStorage, the same place the cosmetic skin lives: it
 * is a property of this person's window, not of the design on disk.
 */
type PaneKey = 'list' | 'canvas' | 'detail';
const PANE_ORDER_KEY = 'iss.paneOrder';
const DEFAULT_PANE_ORDER: PaneKey[] = ['list', 'canvas', 'detail'];

function loadPaneOrder(): PaneKey[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PANE_ORDER_KEY) ?? 'null');
    if (!Array.isArray(raw)) return DEFAULT_PANE_ORDER;
    const order = raw.filter((k): k is PaneKey => DEFAULT_PANE_ORDER.includes(k as PaneKey));
    // A stored order missing a pane (an older build, a hand-edited value) must
    // not make that pane unreachable — append whatever is absent.
    for (const key of DEFAULT_PANE_ORDER) if (!order.includes(key)) order.push(key);
    return order;
  } catch {
    return DEFAULT_PANE_ORDER;
  }
}

export function Bench({ transport }: { transport: HostTransport }) {
  return (
    <TransportProvider transport={transport}>
      <BenchInner />
    </TransportProvider>
  );
}

function BenchInner() {
  const s = useDesignSession();
  const [library, setLibrary] = useState(false);
  const [dock, setDock] = useState(false);
  const [listTab, setListTab] = useState<ListTab>('blocks');
  const [listOpen, setListOpen] = useState(true);
  const [listWidth, setListWidth] = useState(264);
  const [detailOpen, setDetailOpen] = useState(true);
  const [paneOrder, setPaneOrder] = useState<PaneKey[]>(loadPaneOrder);
  const [dragPane, setDragPane] = useState<PaneKey | null>(null);
  const [term, setTerm] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<string | null>(null);
  /** Custody classes the canvas is currently dimming. Chips drive it. */
  const [muted, setMuted] = useState<Set<string>>(new Set());

  useEffect(() => {
    void window.iss.state().then((st) => setEditor(st.editor));
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PANE_ORDER_KEY, JSON.stringify(paneOrder));
    } catch {
      // A window that can't remember its layout is still a usable window.
    }
  }, [paneOrder]);

  /** Header props that make a pane draggable and a drop target. */
  const paneDrag = useCallback(
    (key: PaneKey) => ({
      draggable: true,
      className: `pane-head${dragPane && dragPane !== key ? ' pane-drop' : ''}`,
      onDragStart: (e: React.DragEvent) => {
        setDragPane(key);
        e.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without payload; the value is unused.
        e.dataTransfer.setData('text/plain', key);
      },
      onDragEnd: () => setDragPane(null),
      onDragOver: (e: React.DragEvent) => {
        if (!dragPane || dragPane === key) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (dragPane) movePaneRef.current(dragPane, key);
      },
    }),
    [dragPane],
  );

  /** Drop `dragged` onto `target`: the two panes trade slots. */
  const movePane = useCallback((dragged: PaneKey, target: PaneKey) => {
    if (dragged === target) return;
    setPaneOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(dragged);
      const to = next.indexOf(target);
      if (from < 0 || to < 0) return prev;
      next[from] = target;
      next[to] = dragged;
      return next;
    });
    setDragPane(null);
  }, []);
  const movePaneRef = useRef(movePane);
  movePaneRef.current = movePane;

  const selectedCount = s.selection.nodes.size + (s.selection.wire ? 1 : 0);
  const problems = useProblems(s);

  const phase = s.runStatus.phase;
  useEffect(() => {
    if (phase === 'error') setDock(true);
  }, [phase]);
  useEffect(() => {
    if (problems.length > 0) setListTab('problems');
  }, [problems.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setLibrary((v) => !v);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setListOpen((v) => !v);
        return;
      }
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        setTerm((v) => !v);
        setDock(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setDock((v) => !v);
        return;
      }
      if (e.key === 'Escape' && library) {
        e.preventDefault();
        e.stopPropagation();
        setLibrary(false);
      }
      if (!typing && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        s.post({ type: 'simulate' });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [library, s]);

  const addFromLibrary = useCallback(
    (t: (typeof TEMPLATES)[number]) => {
      s.addBlockAt(t.prefix, 120, 120, t.kind, t.io, t.role);
      setLibrary(false);
    },
    [s],
  );

  const canvasMute = [...muted].map((m) => `mute-${m}`).join(' ');

  return (
    <div className={`shell ${s.design ? '' : 'shell-spec'}`}>
      <TitleBar
        s={s}
        onOpenLibrary={() => setLibrary(true)}
        onLocal={(action) => {
          if (action === 'list') setListOpen((v) => !v);
          else if (action === 'dock') setDock((v) => !v);
          else if (action === 'terminal') { setTerm((v) => !v); setDock(true); }
          else if (action === 'detail') setDetailOpen((v) => !v);
          else if (action === 'palette') setLibrary(true);
          else if (action === 'config') s.setShowRunConfig(!s.showRunConfig);
        }}
        problemCount={problems.length}
        listOpen={listOpen}
        dockOpen={dock}
        termOpen={term}
        detailOpen={detailOpen}
      />
      <ScopeBar
        s={s}
        muted={muted}
        onToggleMute={(k) =>
          setMuted((prev) => {
            const next = new Set(prev);
            if (next.has(k)) next.delete(k);
            else next.add(k);
            return next;
          })
        }
        listOpen={listOpen}
        onToggleList={() => setListOpen((v) => !v)}
      />

      {s.showRunConfig && (
        <RunConfigPanel
          config={s.runConfig}
          graph={s.graph}
          onSave={(config) => {
            s.setRunConfig(config);
            s.post({ type: 'setRunConfig', config });
          }}
          onClose={() => s.setShowRunConfig(false)}
        />
      )}

      <div className="panes">
        {paneOrder.map((key) => {
          if (key === 'list') {
            if (!s.design || !listOpen) return null;
            // The drag handle for the tree lives in ListPane's own header.
            return (
              <React.Fragment key="list">
                {paneOrder.indexOf('list') === paneOrder.length - 1 && (
                  <Resizer width={listWidth} onWidth={setListWidth} />
                )}
                <ListPane
                  s={s}
                  tab={listTab}
                  onTab={setListTab}
                  problems={problems}
                  width={listWidth}
                  expanded={expanded}
                  onToggleExpand={(id) =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  drag={paneDrag('list')}
                />
                {paneOrder.indexOf('list') !== paneOrder.length - 1 && (
                  <Resizer width={listWidth} onWidth={setListWidth} />
                )}
              </React.Fragment>
            );
          }

          if (key === 'detail') {
            if (!s.design || !detailOpen || selectedCount === 0) return null;
            return (
              <section className="pane pane-detail" key={[...s.selection.nodes][0] ?? s.selection.wire ?? ''}>
                <header {...paneDrag('detail')}>
                  <span className="pane-grip" aria-hidden="true">
                    ⠿
                  </span>
                  <span className="pane-title">Inspector</span>
                  <span className="pane-spacer" />
                  <button
                    className="pane-x"
                    title="Close the inspector"
                    onClick={() => setDetailOpen(false)}
                  >
                    ✕
                  </button>
                </header>
              <Inspector
                graph={s.graph}
                authored={s.authored}
                selection={s.selection}
                spec={s.spec}
                onEdit={(intent, entry) => {
                  s.sendEdit(intent);
                  if (entry) s.pushUndo(entry);
                }}
                onReveal={(id) => s.post({ type: 'reveal', id })}
                onRevealEvent={(id) => s.post({ type: 'revealEvent', id })}
                onDelete={s.deleteSelection}
                onDeleteWire={s.deleteWireById}
                onDrillIn={(id) => {
                  s.setCurrentPath(id);
                  s.setSelection({ nodes: new Set(), wire: null });
                }}
                onDuplicate={s.duplicateBlock}
                onAddPin={s.addPinToComposite}
              />
              </section>
            );
          }

          return (
            <section className="pane pane-canvas" key="canvas">

          {s.design ? (
            <>
              <header {...paneDrag('canvas')}>
                <span className="pane-grip" aria-hidden="true">
                  ⠿
                </span>
                <Breadcrumb s={s} />
                <span className="pane-spacer" />
                <span className="pane-meta">
                  {s.graph.components.length} blocks · {s.graph.links.length} wires
                </span>
              </header>
              <div className={`pane-body ${canvasMute}`}>
                <Canvas
                  graph={s.graph}
                  layout={s.layout}
                  authored={s.authored}
                  selection={s.selection}
                  tool={s.tool}
                  trace={s.trace}
                  playhead={s.playhead}
                  divergences={s.activeDivergences}
                  zoomTick={s.zoomTick}
                  currentPath={s.currentPath}
                  entryIds={s.entryIds}
                  onSelect={s.setSelection}
                  onMove={(moves) => {
                    const before = { ...s.layoutRef.current };
                    const next = { ...s.layoutRef.current, ...moves };
                    s.persistLayout(next);
                    s.pushUndo({
                      undo: () => s.persistLayout(before),
                      redo: () => s.persistLayout(next),
                    });
                  }}
                  onConnect={s.connect}
                  onAddBlock={s.addBlockAt}
                  onAddPin={s.addPinToComposite}
                  onDeleteWire={s.deleteWireById}
                  onAttachRouter={s.attachRouter}
                  onLinkRouters={s.linkRouters}
                  onAddRule={s.addRule}
                  wireStyle={s.wireStyle}
                  collapsed={s.collapsed}
                  onToggleCollapse={s.toggleCollapsed}
                  renamingId={s.renamingId}
                  onRenameStart={s.startRename}
                  onRenameEnd={s.endRename}
                  onReveal={(id) => s.post({ type: 'reveal', id })}
                  onRevealEvent={(id) => s.post({ type: 'revealEvent', id })}
                  onDrillIn={(id) => {
                    s.setCurrentPath(id);
                    s.setSelection({ nodes: new Set(), wire: null });
                  }}
                />
                <ToolCluster s={s} onOpenLibrary={() => setLibrary(true)} />
                {s.toast && <div className="toast">{s.toast}</div>}
              </div>
            </>
          ) : (
            <div className="pane-body pane-scroll">
              <SpecDesigner
                spec={s.spec}
                onEdit={(edit) => s.post({ type: 'specEdit', edit })}
                onCreate={(templateId) => s.post({ type: 'createSpec', templateId })}
              />
              {s.toast && <div className="toast">{s.toast}</div>}
            </div>
          )}
        
            </section>
          );
        })}
      </div>

      <Ledger
        s={s}
        open={dock}
        onToggle={() => setDock((v) => !v)}
        problemCount={problems.length}
        editor={editor}
        terminal={term}
        onToggleTerminal={() => { setTerm((v) => !v); setDock(true); }}
      />

      {library && (
        <Library
          s={s}
          templates={TEMPLATES}
          onPick={addFromLibrary}
          onPickNamed={(name, kind) => {
            s.addNamedBlock(name, kind);
            setLibrary(false);
          }}
          onClose={() => setLibrary(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ problems */

interface Problem {
  severity: 'error' | 'warning';
  title: string;
  detail: string;
  component?: string;
}

/** Design-time diagnostics, dangling stubs and run divergences, as one list. */
function useProblems(s: Session): Problem[] {
  return useMemo(() => {
    const out: Problem[] = [];
    for (const d of s.graph.diagnostics ?? [])
      out.push({ severity: d.severity, title: d.kind, detail: d.detail, component: d.component });
    for (const stub of s.graph.stubs)
      out.push({
        severity: 'warning',
        title: 'dangling output',
        detail: `${stub.from}.${stub.port} — ${stub.reason}`,
        component: stub.from,
      });
    for (const l of s.graph.links)
      if (l.status === 'unresolved')
        out.push({
          severity: 'error',
          title: 'unresolved wire',
          detail: `${l.from}.${l.fromPort} points at nothing`,
          component: l.from,
        });
    for (const d of s.trace.divergences)
      out.push({
        severity: 'error',
        title: 'divergence',
        detail: `cycle ${d.cycle} · token ${d.token} — ${d.detail}`,
        component: d.component,
      });
    return out;
  }, [s.graph, s.trace.divergences]);
}

/* ------------------------------------------------------------------ title bar */

/** The menu bar. Only actions that exist — a menu naming things the app cannot
 *  do is worse than no menu. */
const MENUS: Array<{ label: string; items: Array<{ label: string; action: string; key?: string } | 'sep'> }> = [
  {
    label: 'File',
    items: [
      { label: 'Open Project…', action: 'openProject', key: '⌘O' },
      { label: 'Close Project', action: 'closeProject' },
      'sep',
      { label: 'Exit', action: 'quit' },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Toggle List Pane', action: '@list', key: '⌘B' },
      { label: 'Toggle Panel', action: '@dock', key: '⌘J' },
      { label: 'Toggle Terminal', action: '@terminal', key: '⌃`' },
      'sep',
      { label: 'Command Palette…', action: '@palette', key: '⌘K' },
      'sep',
      { label: 'Reload Window', action: 'reload' },
      { label: 'Toggle Developer Tools', action: 'devtools' },
    ],
  },
  {
    label: 'Run',
    items: [
      { label: 'Run Simulation', action: 'run', key: '⌘⏎' },
      { label: 'Verify Against Oracle', action: 'verify' },
      'sep',
      { label: 'Run Configuration…', action: '@config' },
    ],
  },
  {
    label: 'Terminal',
    items: [
      { label: 'New Terminal', action: '@terminal', key: '⌃`' },
      'sep',
      { label: 'Open Project in Editor', action: 'openInEditor', key: '⌘⇧E' },
      { label: 'Reveal in File Manager', action: 'revealInFiles' },
    ],
  },
];

function MenuBar({ onLocal }: { onLocal(action: string): void }) {
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const fire = (action: string) => {
    setOpen(null);
    if (action.startsWith('@')) onLocal(action.slice(1));
    else window.iss.menu(action);
  };

  return (
    <nav className="menubar" onPointerDown={(e) => e.stopPropagation()}>
      {MENUS.map((m) => (
        <div key={m.label} className="menu-wrap">
          <button
            className={`menu-top ${open === m.label ? 'on' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === m.label}
            onClick={() => setOpen((v) => (v === m.label ? null : m.label))}
            onPointerEnter={() => setOpen((v) => (v ? m.label : v))}
          >
            {m.label}
          </button>
          {open === m.label && (
            <ul className="menu-pop" role="menu">
              {m.items.map((it, i) =>
                it === 'sep' ? (
                  <li key={i} className="menu-sep" role="separator" />
                ) : (
                  <li key={i}>
                    <button className="menu-item" role="menuitem" onClick={() => fire(it.action)}>
                      <span>{it.label}</span>
                      {it.key && <kbd>{it.key}</kbd>}
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      ))}
    </nav>
  );
}

/**
 * The ribbon. Menu bar at the left, the command centre in the middle carrying
 * the workspace name and live status, layout toggles and window controls at the
 * right — the arrangement from the reference, with our own content in it.
 */
function TitleBar(props: {
  s: Session;
  onOpenLibrary(): void;
  onLocal(action: string): void;
  problemCount: number;
  listOpen: boolean;
  dockOpen: boolean;
  termOpen: boolean;
  detailOpen: boolean;
}) {
  const { s, onOpenLibrary, onLocal, problemCount, listOpen, dockOpen, termOpen, detailOpen } = props;
  const running = s.runStatus.phase === 'building' || s.runStatus.phase === 'running';
  const root = s.breadcrumb[0]?.label ?? 'design';

  return (
    <header className="titlebar">
      <span className="tb-mark" aria-hidden="true">◧</span>
      <MenuBar onLocal={onLocal} />

      <div className="tb-spacer" />

      {/* Command centre: the workspace, and what is true about it right now. */}
      <button className="commandcentre" onClick={onOpenLibrary} title="Search blocks and commands (⌘K)">
        <span className="cc-icon" aria-hidden="true">⌕</span>
        <span className="cc-text">{root}</span>
        {problemCount > 0 && (
          <span className="cc-badge" title={`${problemCount} unresolved`}>
            ⊗ {problemCount}
          </span>
        )}
        {running && <span className="cc-run">{s.runStatus.phase}…</span>}
        <kbd className="cc-kbd">⌘K</kbd>
      </button>

      <div className="tb-spacer" />

      {/* Layout toggles, in the reference's position and meaning. */}
      <div className="tb-layout">
        <button
          className={listOpen ? 'on' : ''}
          aria-pressed={listOpen}
          title="Toggle list pane (⌘B)"
          onClick={() => onLocal('list')}
        >▤</button>
        <button
          className={dockOpen ? 'on' : ''}
          aria-pressed={dockOpen}
          title="Toggle panel (⌘J)"
          onClick={() => onLocal('dock')}
        >▂</button>
        <button
          className={termOpen ? 'on' : ''}
          aria-pressed={termOpen}
          title="Toggle terminal (⌃`)"
          onClick={() => onLocal('terminal')}
        >❯</button>
        <button
          className={detailOpen ? 'on' : ''}
          aria-pressed={detailOpen}
          title="Toggle inspector"
          onClick={() => onLocal('detail')}
        >▥</button>
      </div>

      <SkinSwitch />
      <button
        className={`tb-run ${running ? 'busy' : ''}`}
        disabled={running}
        onClick={() => s.post({ type: 'simulate' })}
        title="Compile & run on the engine (⌘⏎)"
      >
        {s.runStatus.phase === 'building' ? 'Building…' : running ? 'Running…' : '▶ Run'}
      </button>

      <div className="winctl">
        <button title="Minimize" onClick={() => window.iss.window('minimize')}>─</button>
        <button title="Maximize" onClick={() => window.iss.window('maximize')}>▢</button>
        <button className="close" title="Close" onClick={() => window.iss.window('close')}>✕</button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ scope bar */

const CUSTODY: Array<{ key: string; label: string }> = [
  { key: 'wired', label: 'wired' },
  { key: 'routed', label: 'routed' },
  { key: 'inferred', label: 'inferred' },
  { key: 'unresolved', label: 'unresolved' },
];

/**
 * Live counts that also filter. Chips in the reference are not badges — they
 * are the filter, and the number on them is real. Here each one counts links of
 * that custody class and toggles them down on the canvas.
 */
function ScopeBar(props: {
  s: Session;
  muted: Set<string>;
  onToggleMute(key: string): void;
  listOpen: boolean;
  onToggleList(): void;
}) {
  const { s, muted, onToggleMute, listOpen, onToggleList } = props;

  const counts = useMemo(() => {
    const c: Record<string, number> = { wired: 0, routed: 0, inferred: 0, unresolved: 0 };
    for (const l of s.graph.links) if (l.status in c) c[l.status] += 1;
    return c;
  }, [s.graph.links]);

  return (
    <div className="scopebar">
      <button
        className="sb-icon"
        onClick={onToggleList}
        aria-pressed={listOpen}
        title="Toggle the list pane (⌘B)"
      >
        ▤
      </button>

      <div className="seg" role="group" aria-label="View">
        <button className={s.design ? 'on' : ''} aria-pressed={s.design} onClick={() => s.setActiveTab('design')}>
          Bench
        </button>
        <button className={!s.design ? 'on' : ''} aria-pressed={!s.design} onClick={() => s.setActiveTab('spec')}>
          Spec
        </button>
      </div>

      <span className="sb-rule" />

      {CUSTODY.map((c) => (
        <button
          key={c.key}
          className={`chip chip-${c.key} ${muted.has(c.key) ? 'off' : ''}`}
          aria-pressed={!muted.has(c.key)}
          onClick={() => onToggleMute(c.key)}
          title={`${counts[c.key]} ${c.label} — click to dim on the canvas`}
        >
          <span className="chip-dot" aria-hidden="true" />
          {c.label}
          <span className="chip-n">{counts[c.key]}</span>
        </button>
      ))}
      {s.graph.stubs.length > 0 && (
        <span className="chip chip-stub" title="outputs with no consumer">
          <span className="chip-dot" aria-hidden="true" />
          stubs<span className="chip-n">{s.graph.stubs.length}</span>
        </span>
      )}

      <span className="sb-spacer" />

      <label className="sb-select">
        Level
        <select
          value={s.currentPath ?? '__root__'}
          onChange={(e) => {
            s.setCurrentPath(e.target.value === '__root__' ? null : e.target.value);
            s.setSelection({ nodes: new Set(), wire: null });
          }}
        >
          <option value="__root__">design (root)</option>
          {s.graph.components
            .filter((c) => c.kind === 'composite')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ list pane */

function ListPane(props: {
  s: Session;
  tab: ListTab;
  onTab(t: ListTab): void;
  problems: Problem[];
  width: number;
  expanded: Set<string>;
  onToggleExpand(id: string): void;
  /** Header props that make this pane draggable to another slot. */
  drag: React.HTMLAttributes<HTMLElement> & { draggable: boolean };
}) {
  const { s, tab, onTab, problems, width, expanded, onToggleExpand, drag } = props;
  const [query, setQuery] = useState('');

  /** children keyed by parent — the tree is the design's real hierarchy, not
   *  a flat list of whatever level the canvas happens to be showing. */
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, typeof s.graph.components>();
    for (const c of s.graph.components) {
      const list = m.get(c.parent) ?? [];
      list.push(c);
      m.set(c.parent, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.label.localeCompare(b.label));
    return m;
  }, [s.graph.components]);

  /** A filter reveals: matching a nested block expands the path down to it. */
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    const hit = new Set<string>();
    for (const c of s.graph.components) {
      if (c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) {
        hit.add(c.id);
        let p = c.parent;
        while (p) {
          hit.add(p);
          const parent = s.graph.components.find((x) => x.id === p);
          p = parent ? parent.parent : null;
        }
      }
    }
    return hit;
  }, [q, s.graph.components]);

  const glyph = (kind: string, io?: string) =>
    kind === 'composite' ? '▣' : kind === 'router' ? '◈' : io ? '⇄' : '▢';

  const renderLevel = (parent: string | null, depth: number): React.ReactNode => {
    const kids = childrenOf.get(parent) ?? [];
    return kids
      .filter((c) => !matches || matches.has(c.id))
      .map((c) => {
        const hasKids = (childrenOf.get(c.id) ?? []).length > 0;
        const isOpen = expanded.has(c.id) || Boolean(matches);
        const selected = s.selection.nodes.has(c.id);
        return (
          <li key={c.id}>
            <div
              className={`row tree-row ${selected ? 'on' : ''}`}
              style={{ paddingLeft: 6 + depth * 13 }}
            >
              <button
                className={`tree-twisty ${hasKids ? '' : 'leafless'}`}
                aria-expanded={hasKids ? isOpen : undefined}
                tabIndex={hasKids ? 0 : -1}
                title={hasKids ? (isOpen ? 'Collapse' : 'Expand') : undefined}
                onClick={() => hasKids && onToggleExpand(c.id)}
              >
                {hasKids ? (isOpen ? '▾' : '▸') : ''}
              </button>
              <button
                className="tree-label"
                onClick={() => {
                  s.setCurrentPath(c.parent);
                  s.setSelection({ nodes: new Set([c.id]), wire: null });
                }}
                onDoubleClick={() =>
                  c.kind === 'composite'
                    ? s.setCurrentPath(c.id)
                    : s.post({ type: 'reveal', id: c.id })
                }
                title={`${c.id} — double-click to ${
                  c.kind === 'composite' ? 'drill in' : 'open its source'
                }`}
              >
                <span className={`row-glyph g-${c.kind}`}>{glyph(c.kind, c.io)}</span>
                <span className="row-name">{c.label}</span>
                {c.outPorts.length > 0 && <span className="row-meta">{c.outPorts.length}→</span>}
              </button>
            </div>
            {hasKids && isOpen && <ul className="tree">{renderLevel(c.id, depth + 1)}</ul>}
          </li>
        );
      });
  };

  return (
    <section className="pane pane-list" style={{ width }}>
      <header {...drag}>
        <span className="pane-grip" aria-hidden="true">
          ⠿
        </span>
        <div className="seg seg-sm" role="group" aria-label="List">
          <button className={tab === 'blocks' ? 'on' : ''} aria-pressed={tab === 'blocks'} onClick={() => onTab('blocks')}>
            Hierarchy
          </button>
          <button className={tab === 'events' ? 'on' : ''} aria-pressed={tab === 'events'} onClick={() => onTab('events')}>
            Messages
            {s.graph.events.length > 0 && <span className="seg-n">{s.graph.events.length}</span>}
          </button>
          <button className={tab === 'problems' ? 'on' : ''} aria-pressed={tab === 'problems'} onClick={() => onTab('problems')}>
            Problems
            {problems.length > 0 && <span className="seg-n">{problems.length}</span>}
          </button>
        </div>
      </header>

      {tab === 'blocks' ? (
        <>
          <div className="list-search">
            <input
              placeholder="Filter the hierarchy…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="pane-body pane-scroll">
            {(childrenOf.get(null) ?? []).length === 0 && (
              <p className="list-empty">No blocks yet. ⌘K to add one.</p>
            )}
            <ul className="tree tree-root">{renderLevel(null, 0)}</ul>
          </div>
        </>
      ) : tab === 'events' ? (
        <div className="pane-body">
          <EventsView
            graph={s.graph}
            authored={s.authored}
            spec={s.spec}
            onEdit={(intent, entry) => {
              s.sendEdit(intent);
              if (entry) s.pushUndo(entry);
            }}
            onReveal={(id) => s.post({ type: 'revealEvent', id })}
            onPickComponent={(id) => {
              const comp = s.graph.components.find((c) => c.id === id);
              if (comp) s.setCurrentPath(comp.parent);
              s.setSelection({ nodes: new Set([id]), wire: null });
            }}
          />
        </div>
      ) : (
        <div className="pane-body pane-scroll">
          {problems.length === 0 && (
            <p className="list-empty">Nothing unresolved. Every wire is substantiated.</p>
          )}
          <ul className="list">
            {problems.map((p, i) => (
              <li key={i}>
                <button
                  className={`row row-problem sev-${p.severity}`}
                  onClick={() =>
                    p.component && s.setSelection({ nodes: new Set([p.component]), wire: null })
                  }
                  title={p.detail}
                >
                  <span className="row-glyph">{p.severity === 'error' ? '⛔' : '⚠'}</span>
                  <span className="row-stack">
                    <span className="row-name">{p.title}</span>
                    <span className="row-detail">{p.detail}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** A real drag handle — panes in this class of tool are always resizable. */
function Resizer({ width, onWidth }: { width: number; onWidth(w: number): void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const next = start.current.w + (e.clientX - start.current.x);
        onWidth(Math.max(180, Math.min(460, next)));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
    />
  );
}

/* ------------------------------------------------------------------ fragments */

function Breadcrumb({ s }: { s: Session }) {
  return (
    <nav className="crumbs">
      {s.breadcrumb.map((part, i) => (
        <span key={part.path ?? '__root__'} className="crumb-wrap">
          {i > 0 && <span className="crumb-sep" aria-hidden="true">›</span>}
          <button
            className={`crumb ${i === s.breadcrumb.length - 1 ? 'on' : ''}`}
            onClick={() => {
              s.setCurrentPath(part.path);
              s.setSelection({ nodes: new Set(), wire: null });
            }}
          >
            {part.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

function SkinSwitch() {
  const [skin, setSkin] = useState<SkinId>(() => loadSkin());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const current = SKINS.find((x) => x.id === skin);

  return (
    <div className="skin-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <button className="tb-btn" aria-haspopup="menu" aria-expanded={open} title="Cosmetic mode" onClick={() => setOpen((v) => !v)}>
        {current?.label}
        <span className="tb-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="skin-menu" role="menu">
          {SKINS.map((x) => (
            <li key={x.id}>
              <button
                role="menuitemradio"
                aria-checked={x.id === skin}
                className={`skin-item ${x.id === skin ? 'on' : ''}`}
                onClick={() => {
                  applySkin(x.id);
                  setSkin(x.id);
                  setOpen(false);
                }}
              >
                <span className="skin-item-name">{x.label}</span>
                <span className="skin-item-note">{x.note}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Camera and history, floated over the canvas rather than given a rail. */
function ToolCluster({ s, onOpenLibrary }: { s: Session; onOpenLibrary(): void }) {
  return (
    <>
      <div className="canvas-float canvas-float-tl">
        <button
          className={s.tool === 'select' ? 'on' : ''}
          aria-pressed={s.tool === 'select'}
          title="Select (V)"
          onClick={() => s.setTool('select')}
        >
          ⬚
        </button>
        <button
          className={s.tool === 'hand' ? 'on' : ''}
          aria-pressed={s.tool === 'hand'}
          title="Pan (H) — right-drag also pans"
          onClick={() => s.setTool('hand')}
        >
          ✋
        </button>
        <i className="float-rule" />
        <button title="Undo (⌘Z)" onClick={s.undo}>↩</button>
        <button title="Redo (⌘⇧Z)" onClick={s.redo}>↪</button>
        <i className="float-rule" />
        <button
          className={s.wireStyle === 'square' ? 'on' : ''}
          aria-pressed={s.wireStyle === 'square'}
          title={
            s.wireStyle === 'square'
              ? 'Wires: square (Manhattan) — click for curvy'
              : 'Wires: curvy — click for square (Manhattan)'
          }
          onClick={() => s.setWireStyle(s.wireStyle === 'square' ? 'curvy' : 'square')}
        >
          {s.wireStyle === 'square' ? '⌐' : '∿'}
        </button>
        <i className="float-rule" />
        <button className="float-accent" title="Add a block (⌘K)" onClick={onOpenLibrary}>+</button>
      </div>

      <div className="canvas-float canvas-float-br">
        <button title="Auto-layout this level" onClick={s.applyAutoLayout}>⇹</button>
        <button title="Fit to view" onClick={() => s.bumpZoom((t: number) => t + 1)}>⤢</button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ terminal */

/** A shell rooted at the project. Line-oriented — see electron/terminal.ts. */
function TerminalPane() {
  const [lines, setLines] = useState('');
  const [input, setInput] = useState('');
  const body = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const off = window.iss.onTermData((chunk) =>
      setLines((prev) => (prev + chunk).slice(-40_000)),
    );
    window.iss.term(''); // start it
    return off;
  }, []);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [lines]);

  return (
    <div className="term">
      <pre className="term-out" ref={body}>{lines}</pre>
      <form
        className="term-in"
        onSubmit={(e) => {
          e.preventDefault();
          setLines((prev) => `${prev}$ ${input}\n`);
          window.iss.term(`${input}\n`);
          setInput('');
        }}
      >
        <span className="term-prompt" aria-hidden="true">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="make, ./build/design 64, git status…"
          spellCheck={false}
          aria-label="Shell command"
        />
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------- ledger */

function Ledger(props: {
  s: Session;
  open: boolean;
  onToggle(): void;
  problemCount: number;
  editor: string | null;
  terminal: boolean;
  onToggleTerminal(): void;
}) {
  const { s, open, onToggle, problemCount, editor, terminal, onToggleTerminal } = props;
  const cycles = s.trace.cycles;

  return (
    <footer className={`ledger ${open ? 'open' : ''}`}>
      <button className="ledger-strip" onClick={onToggle} aria-expanded={open}>
        <span className={`lg-phase lg-${s.runStatus.phase}`}>{s.runStatus.phase}</span>
        {s.sail && <span className="lg-item">oracle · {s.sail.ref}</span>}
        {s.spec?.name && <span className="lg-item">{s.spec.name}</span>}
        <span className="lg-item lg-editor" title="Double-clicking a block opens its source here">
          {editor ? `opens in ${editor}` : 'no editor found'}
        </span>
        <span className="lg-spacer" />
        {cycles > 0 && (
          <span className="lg-item lg-measured">
            cycle {Math.floor(s.playhead)} / {cycles}
          </span>
        )}
        {problemCount > 0 && <span className="lg-problems">{problemCount} to answer for</span>}
        <span
          className={`lg-term ${terminal ? 'on' : ''}`}
          role="button"
          tabIndex={0}
          title="Toggle the integrated shell (⌃`)"
          onClick={(e) => { e.stopPropagation(); onToggleTerminal(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggleTerminal(); }
          }}
        >
          ❯ shell
        </span>
        <span className="lg-chev" aria-hidden="true">{open ? '▾' : '▴'}</span>
      </button>

      {open && terminal && (
        <div className="ledger-body"><TerminalPane /></div>
      )}
      {open && !terminal && (
        <div className="ledger-body">
          <BottomPanel
            trace={s.trace}
            playhead={s.playhead}
            playing={s.playing}
            speed={s.speed}
            consoleLines={s.consoleLines}
            divergences={s.trace.divergences}
            diagnostics={s.graph.diagnostics ?? []}
            waves={s.waves}
            labels={Object.fromEntries(s.graph.components.map((c) => [c.id, c.label]))}
            collapsed={false}
            onToggleCollapse={onToggle}
            onPlay={() => s.setPlaying(s.trace.cycles > 0)}
            onPause={() => s.setPlaying(false)}
            onStep={(d: number) =>
              s.setPlayhead((p: number) => Math.max(0, Math.min(s.trace.cycles, Math.round(p) + d)))
            }
            onScrub={s.setPlayhead}
            onSpeed={s.setSpeed}
            onPickCell={(block: string, cycle: number) => {
              s.setActiveTab('design');
              s.setPlaying(false);
              s.setPlayhead(cycle);
              const comp = s.graphRef.current.components.find((c) => c.id === block);
              if (comp) s.setCurrentPath(comp.parent);
              s.setSelection({ nodes: new Set([block]), wire: null });
            }}
            onRevealDivergence={(d) => {
              s.setActiveTab('design');
              s.setSelection({ nodes: new Set([d.component]), wire: null });
              s.setPlayhead(d.cycle);
              s.post({ type: 'reveal', id: d.component });
            }}
          />
        </div>
      )}
    </footer>
  );
}

/* ------------------------------------------------------------------- library */

/** Blocks and commands in one palette — the command centre's target. */
function Library(props: {
  s: Session;
  templates: typeof TEMPLATES;
  onPick(t: (typeof TEMPLATES)[number]): void;
  onPickNamed(name: string, kind: ComponentKind): void;
  onClose(): void;
}) {
  const { s, templates, onPick, onPickNamed, onClose } = props;
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const q = query.trim().toLowerCase();

  /** Existing blocks first: with a real design open, you are usually looking
      for something that already exists, not adding an eleventh template. */
  const found = useMemo(() => {
    const blocks = q
      ? s.graph.components
          .filter((c) => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
          .slice(0, 8)
          .map((c) => ({
            kind: 'block' as const,
            id: c.id,
            glyph: c.kind === 'composite' ? '▣' : c.kind === 'router' ? '◈' : '▢',
            label: c.label,
            hint: c.id,
          }))
      : [];
    const adds = templates
      .filter((t) => !q || t.label.toLowerCase().includes(q) || t.prefix.toLowerCase().includes(q) || t.hint.toLowerCase().includes(q))
      .map((t) => ({ kind: 'add' as const, id: t.prefix, glyph: t.glyph, label: `Add ${t.label}`, hint: t.hint, t }));
    return [...blocks, ...adds];
  }, [q, s.graph.components, templates]);

  useEffect(() => setCursor(0), [query]);

  const named = query.trim();
  const canName = found.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(named);

  const run = (i: number) => {
    const item = found[i];
    if (!item) {
      if (canName) onPickNamed(named, 'leaf');
      return;
    }
    if (item.kind === 'add') onPick(item.t);
    else {
      const comp = s.graph.components.find((c) => c.id === item.id);
      if (comp) s.setCurrentPath(comp.parent);
      s.setSelection({ nodes: new Set([item.id]), wire: null });
      onClose();
    }
  };

  return (
    <div className="lib-scrim" onPointerDown={onClose}>
      <div className="lib" role="dialog" aria-label="Search blocks and commands" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="lib-input"
          placeholder="Search blocks and commands, or type a new block name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(found.length - 1, c + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(cursor);
            }
          }}
        />
        <ul className="lib-list">
          {found.map((item, i) => (
            <li key={`${item.kind}:${item.id}`}>
              <button
                className={`lib-row ${i === cursor ? 'on' : ''}`}
                onPointerEnter={() => setCursor(i)}
                onClick={() => run(i)}
              >
                <span className="lib-glyph">{item.glyph}</span>
                <span className="lib-label">{item.label}</span>
                <span className="lib-hint">{item.hint}</span>
              </button>
            </li>
          ))}
          {found.length === 0 && (
            <li>
              {canName ? (
                <button className="lib-row on" onClick={() => onPickNamed(named, 'leaf')}>
                  <span className="lib-glyph">▢</span>
                  <span className="lib-label">Create “{named}”</span>
                  <span className="lib-hint">a new block with exactly this class name</span>
                </button>
              ) : (
                <p className="lib-empty">
                  No block or command matches. A valid C++ identifier creates a block with
                  that exact name.
                </p>
              )}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
