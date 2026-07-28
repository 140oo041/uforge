// The IDE shell: the arrangement that belongs inside VS Code.
//
// Rails and a dock, because here the surface is a panel among panels and should
// read as part of the editor. All state and behaviour come from
// useDesignSession(); this file is layout and nothing else.
//
// The standalone desktop app deliberately does NOT use this shell — see
// app/src/bench.tsx, which composes the same pieces full-bleed.

import { Canvas } from './canvas';
import { Palette } from './palette';
import { Inspector } from './inspector';
import { EventsView } from './events-view';
import { SpecDesigner } from './spec-designer';
import { BottomPanel } from './bottom-panel';
import { RunConfigPanel } from './run-config';
import { ActivityBar, StatusBar, TabBar } from './shell';
import { TransportProvider, type HostTransport } from './transport';
import { useDesignSession } from './useDesignSession';

export type { Authored, UndoEntry, DesignSession } from './useDesignSession';

export function App() {
  const {
    post, sendEdit,
    graph, layout, authored, spec, trace, waves, runConfig, runStatus, sail,
    selection, setSelection, tool, setTool, currentPath, setCurrentPath,
    activeTab, setActiveTab, panelCollapsed, setPanelCollapsed,
    showRunConfig, setShowRunConfig, renamingId, toast, design,
    zoomTick, bumpZoom, breadcrumb, entryIds, activeDivergences,
    playhead, setPlayhead, playing, setPlaying, speed, setSpeed, consoleLines,
    layoutRef, graphRef,
    persistLayout, pushUndo, undo, redo, applyAutoLayout,
    addBlockAt, addNamedBlock, addPinToComposite, duplicateBlock,
    connect, addRule, attachRouter, linkRouters,
    startRename, endRename, deleteWireById, deleteSelection,
    setRunConfig,
  } = useDesignSession();

  return (
    <div className={`app ${design ? '' : 'app-spec'} ${panelCollapsed ? 'panel-collapsed' : ''}`}>
      <ActivityBar
        active={activeTab}
        onSelect={setActiveTab}
        onTogglePanel={() => setPanelCollapsed((v) => !v)}
      />

      <TabBar
        active={activeTab}
        runConfigOpen={showRunConfig}
        onSelect={setActiveTab}
        onRun={() => post({ type: 'simulate' })}
        onToggleRunConfig={() => setShowRunConfig((v) => !v)}
        onVerify={() => post({ type: 'verify' })}
      />

      {showRunConfig && (
        <RunConfigPanel
          config={runConfig}
          graph={graph}
          onSave={(config) => {
            setRunConfig(config);
            post({ type: 'setRunConfig', config });
          }}
          onClose={() => setShowRunConfig(false)}
        />
      )}

      {design && (
        <aside className="palette-pane">
          <Palette onAdd={addBlockAt} onAddNamed={addNamedBlock} />
        </aside>
      )}

      <main className="editor-pane">
        {design ? (
          <>
            <header className="toolbar">
              <nav className="breadcrumb">
                {breadcrumb.map((part, i) => (
                  <span key={part.path ?? '__root__'}>
                    {i > 0 && <span className="crumb-sep">▸</span>}
                    <button
                      className={`crumb ${i === breadcrumb.length - 1 ? 'on' : ''}`}
                      onClick={() => {
                        setCurrentPath(part.path);
                        setSelection({ nodes: new Set(), wire: null });
                      }}
                    >
                      {part.label}
                    </button>
                  </span>
                ))}
              </nav>
              <div className="tool-group">
                <button
                  className={tool === 'select' ? 'on' : ''}
                  title="Select (V)"
                  onClick={() => setTool('select')}
                >
                  ⬚
                </button>
                <button
                  className={tool === 'hand' ? 'on' : ''}
                  title="Hand / pan (H) — right-drag also pans"
                  onClick={() => setTool('hand')}
                >
                  ✋
                </button>
              </div>
              <div className="tool-group">
                <button title="Undo (Ctrl+Z)" onClick={undo}>
                  ↩
                </button>
                <button title="Redo (Ctrl+Shift+Z)" onClick={redo}>
                  ↪
                </button>
              </div>
              <div className="tool-group">
                <button title="Auto-layout this level" onClick={applyAutoLayout}>
                  ⇹ layout
                </button>
                <button title="Fit to view" onClick={() => bumpZoom((t) => t + 1)}>
                  ⤢ fit
                </button>
              </div>
              <div className="spacer" />
            </header>
            <div className="canvas-pane">
              <Canvas
                graph={graph}
                layout={layout}
                authored={authored}
                selection={selection}
                tool={tool}
                trace={trace}
                playhead={playhead}
                divergences={activeDivergences}
                zoomTick={zoomTick}
                currentPath={currentPath}
                entryIds={entryIds}
                onSelect={setSelection}
                onMove={(moves) => {
                  const before = { ...layoutRef.current };
                  const next = { ...layoutRef.current, ...moves };
                  persistLayout(next);
                  pushUndo({ undo: () => persistLayout(before), redo: () => persistLayout(next) });
                }}
                onConnect={connect}
                onAddBlock={addBlockAt}
                onAddPin={addPinToComposite}
                onDeleteWire={deleteWireById}
                onAttachRouter={attachRouter}
                onLinkRouters={linkRouters}
                onAddRule={addRule}
                renamingId={renamingId}
                onRenameStart={startRename}
                onRenameEnd={endRename}
                onReveal={(id) => post({ type: 'reveal', id })}
                onRevealEvent={(id) => post({ type: 'revealEvent', id })}
                onDrillIn={(id) => {
                  setCurrentPath(id);
                  setSelection({ nodes: new Set(), wire: null });
                }}
              />
              {toast && <div className="toast">{toast}</div>}
            </div>
          </>
        ) : activeTab === 'events' ? (
          <div className="spec-scroll">
            <EventsView
              graph={graph}
              authored={authored}
              spec={spec}
              onEdit={(intent, entry) => {
                sendEdit(intent);
                if (entry) pushUndo(entry);
              }}
              onReveal={(id) => post({ type: 'revealEvent', id })}
              onPickComponent={(id) => {
                setActiveTab('design');
                const comp = graphRef.current.components.find((c) => c.id === id);
                if (comp) setCurrentPath(comp.parent);
                setSelection({ nodes: new Set([id]), wire: null });
              }}
            />
            {toast && <div className="toast">{toast}</div>}
          </div>
        ) : (
          <div className="spec-scroll">
            <SpecDesigner
              spec={spec}
              onEdit={(edit) => post({ type: 'specEdit', edit })}
              onCreate={(templateId) => post({ type: 'createSpec', templateId })}
            />
            {toast && <div className="toast">{toast}</div>}
          </div>
        )}
      </main>

      {design && (
        <aside className="inspector-pane">
          <Inspector
            graph={graph}
            authored={authored}
            selection={selection}
            spec={spec}
            onEdit={(intent, entry) => {
              sendEdit(intent);
              if (entry) pushUndo(entry);
            }}
            onReveal={(id) => post({ type: 'reveal', id })}
            onRevealEvent={(id) => post({ type: 'revealEvent', id })}
            onDelete={deleteSelection}
            onDeleteWire={deleteWireById}
            onDrillIn={(id) => {
              setCurrentPath(id);
              setSelection({ nodes: new Set(), wire: null });
            }}
            onDuplicate={duplicateBlock}
            onAddPin={addPinToComposite}
          />
        </aside>
      )}

      <footer className="panel-pane">
        <BottomPanel
          trace={trace}
          playhead={playhead}
          playing={playing}
          speed={speed}
          consoleLines={consoleLines}
          divergences={trace.divergences}
          diagnostics={graph.diagnostics ?? []}
          waves={waves}
          labels={Object.fromEntries(graph.components.map((c) => [c.id, c.label]))}
          collapsed={panelCollapsed}
          onToggleCollapse={() => setPanelCollapsed((v) => !v)}
          onPlay={() => setPlaying(trace.cycles > 0)}
          onPause={() => setPlaying(false)}
          onStep={(d) =>
            setPlayhead((p) => Math.max(0, Math.min(trace.cycles, Math.round(p) + d)))
          }
          onScrub={setPlayhead}
          onSpeed={setSpeed}
          onPickCell={(block, cycle) => {
            setActiveTab('design');
            setPlaying(false);
            setPlayhead(cycle);
            const comp = graphRef.current.components.find((c) => c.id === block);
            if (comp) setCurrentPath(comp.parent);
            setSelection({ nodes: new Set([block]), wire: null });
          }}
          onRevealDivergence={(d) => {
            setActiveTab('design');
            setSelection({ nodes: new Set([d.component]), wire: null });
            setPlayhead(d.cycle);
            post({ type: 'reveal', id: d.component });
          }}
        />
      </footer>

      <StatusBar
        runStatus={runStatus}
        sail={sail}
        cycles={trace.cycles}
        ranCycles={trace.ranCycles}
        playhead={playhead}
        currentPath={currentPath}
        specName={spec?.name ?? null}
      />
    </div>
  );
}

/**
 * The mount point every host uses. Wrapping here rather than making each host
 * remember the provider keeps the contract to exactly one prop: who to talk to.
 */
export function CanvasApp({ transport }: { transport: HostTransport }) {
  return (
    <TransportProvider transport={transport}>
      <App />
    </TransportProvider>
  );
}
