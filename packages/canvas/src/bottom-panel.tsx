// VS Code-style bottom panel: CONSOLE | TRACE | PIPELINE | WAVES | PROBLEMS
// tabs (+ collapse). TRACE holds the transport (play/step/scrub/speed) and
// live occupancy; PIPELINE is the classic token × cycle stage diagram; WAVES
// shows per-signal VCD lanes from SV co-sim; PROBLEMS lists divergences with
// click-to-reveal.

import { formatBits } from '@iss/contracts/bits';
import { useMemo, useState } from 'react';

import type { FabricDiagnostic } from '@iss/contracts/fabric';
import { leafName } from '@iss/contracts/model';
import { undeliveredHops, type Divergence, type Trace } from '@iss/contracts/trace';
import type { WaveDoc } from '@iss/contracts/waves';
import { histogram, metricsSummary, pathLatencies } from './metrics';
import { occupancyAt, pipelineTable, tokenTimelines } from './tokenAnim';
import { WavesView } from './waves';

const TOKEN_COLORS = ['#4fc3f7', '#ffb74d', '#aed581', '#f06292', '#ba68c8', '#4db6ac', '#fff176', '#a1887f'];

/** Stable per-block hue so pipeline cells are recognizable at a glance. */
function blockHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

interface Props {
  trace: Trace;
  playhead: number;
  playing: boolean;
  speed: number;
  consoleLines: string[];
  divergences: Divergence[];
  /** Design-time fabric diagnostics (cross-top wires, unresolvable rules…) —
   *  listed above the runtime divergences. */
  diagnostics: FabricDiagnostic[];
  waves: WaveDoc[];
  /** Display labels by block id (falls back to the leaf name). */
  labels: Record<string, string>;
  collapsed: boolean;
  onToggleCollapse(): void;
  onPlay(): void;
  onPause(): void;
  onStep(delta: number): void;
  onScrub(cycle: number): void;
  onSpeed(speed: number): void;
  onPickCell(block: string, cycle: number): void;
  onRevealDivergence(d: Divergence): void;
}

type PanelTab = 'console' | 'trace' | 'pipeline' | 'waves' | 'metrics' | 'problems';

/** Per-path latency histogram + per-link/per-router-port tables, from the
 *  run trace (hops) and the engine's metric records. */
function MetricsTab(props: {
  trace: Trace;
  playhead: number;
  labelOf(id: string): string;
  timelines: Map<number, import('@iss/contracts/trace').Hop[]>;
  onPickCell(block: string, cycle: number): void;
}) {
  const { trace, playhead, labelOf, timelines, onPickCell } = props;
  const summary = useMemo(() => metricsSummary(trace), [trace]);
  const blocks = useMemo(() => {
    const ids = new Set<string>();
    for (const h of trace.hops) {
      ids.add(h.from);
      ids.add(h.to);
    }
    return [...ids].sort();
  }, [trace.hops]);
  const busiest = summary.links[0];
  const [pathFrom, setPathFrom] = useState<string>(busiest?.from ?? '');
  const [pathTo, setPathTo] = useState<string>(busiest?.to ?? '');
  const latencies = useMemo(
    () => (pathFrom && pathTo ? pathLatencies(timelines, pathFrom, pathTo) : []),
    [timelines, pathFrom, pathTo],
  );
  const seen = latencies.length;
  const buckets = useMemo(() => histogram(latencies), [latencies]);
  const maxBucket = Math.max(1, ...buckets.map((b) => b.n));

  return (
    <div className="metrics-tab">
      <div className="metrics-col">
        <h5>Links (packets · avg · peak /cycle)</h5>
        <table className="metrics-table">
          <tbody>
            {summary.links.map((l) => (
              <tr
                key={`${l.from}->${l.to}`}
                title={`${l.from} → ${l.to}: ${l.packets} packets — click to jump to ${l.from}`}
                onClick={() => onPickCell(l.from, Math.round(playhead))}
              >
                <td>
                  {labelOf(l.from)} → {labelOf(l.to)}
                </td>
                <td>{l.packets}</td>
                <td>{l.avgBandwidth.toFixed(2)}</td>
                <td>{l.peakPerCycle}</td>
              </tr>
            ))}
            {summary.links.length === 0 && (
              <tr>
                <td className="dim">no hops in this trace</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="metrics-col">
        <h5>Router ports (max · mean depth · bits out · stalls)</h5>
        <table className="metrics-table">
          <tbody>
            {summary.routers.map((r) => (
              <tr
                key={`${r.component}|${r.port}`}
                title={`${r.component} port → ${r.port}: ${r.flow} packets, ${r.bits} bits forwarded — click to jump`}
                onClick={() => onPickCell(r.component, Math.round(playhead))}
              >
                <td>
                  {labelOf(r.component)} → {labelOf(r.port)}
                </td>
                <td>{r.maxDepth}</td>
                <td>{r.meanDepth.toFixed(1)}</td>
                <td>{r.bits > 0 ? formatBits(r.bits) : '—'}</td>
                <td>{r.stalls > 0 ? `${r.stalls} stalls` : '—'}</td>
              </tr>
            ))}
            {summary.routers.length === 0 && (
              <tr>
                <td className="dim">no engine metric records (re-run to collect)</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="metrics-col">
        <h5>Path latency (cycles per token)</h5>
        <div className="metrics-path">
          <select value={pathFrom} onChange={(e) => setPathFrom(e.target.value)}>
            <option value="">from…</option>
            {blocks.map((b) => (
              <option key={b} value={b}>
                {labelOf(b)}
              </option>
            ))}
          </select>
          →
          <select value={pathTo} onChange={(e) => setPathTo(e.target.value)}>
            <option value="">to…</option>
            {blocks.map((b) => (
              <option key={b} value={b}>
                {labelOf(b)}
              </option>
            ))}
          </select>
          <span className="dim"> {seen} token(s)</span>
        </div>
        <svg className="metrics-hist" viewBox={`0 0 ${Math.max(1, buckets.length) * 34} 80`}>
          {buckets.map((b, i) => {
            const h = (b.n / maxBucket) * 56;
            return (
              <g key={i}>
                <rect x={i * 34 + 4} y={64 - h} width={26} height={h} rx={2} />
                <text x={i * 34 + 17} y={62 - h} textAnchor="middle" className="hist-n">
                  {b.n}
                </text>
                <text x={i * 34 + 17} y={76} textAnchor="middle" className="hist-lo">
                  {Number.isInteger(b.lo) ? b.lo : b.lo.toFixed(1)}
                  {b.hi !== b.lo ? '+' : ''}
                </text>
              </g>
            );
          })}
          {buckets.length === 0 && (
            <text x={8} y={40} className="hist-lo">
              pick a path with traffic
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}

export function BottomPanel(props: Props) {
  const {
    trace, playhead, playing, speed, consoleLines, divergences, diagnostics, waves, labels, collapsed,
    onToggleCollapse, onPlay, onPause, onStep, onScrub, onSpeed, onPickCell,
    onRevealDivergence,
  } = props;
  const [tab, setTab] = useState<PanelTab>('console');

  const labelOf = (id: string) => labels[id] ?? leafName(id);
  const timelines = useMemo(() => tokenTimelines(trace), [trace]);
  const undelivered = useMemo(() => undeliveredHops(trace), [trace]);
  const problemCount =
    diagnostics.length + divergences.length + (undelivered.length > 0 ? 1 : 0);
  const occupancy = useMemo(
    () => [...occupancyAt(timelines, playhead).entries()].sort((a, b) => b[1] - a[1]),
    [timelines, playhead],
  );
  const pipeline = useMemo(() => pipelineTable(trace), [trace]);

  const pick = (t: PanelTab) => {
    setTab(t);
    if (collapsed) onToggleCollapse();
  };

  return (
    <div className="panel">
      <div className="panel-tabs">
        <button className={tab === 'console' && !collapsed ? 'on' : ''} onClick={() => pick('console')}>
          CONSOLE
        </button>
        <button className={tab === 'trace' && !collapsed ? 'on' : ''} onClick={() => pick('trace')}>
          TRACE
        </button>
        <button className={tab === 'pipeline' && !collapsed ? 'on' : ''} onClick={() => pick('pipeline')}>
          PIPELINE
        </button>
        {waves.length > 0 && (
          <button className={tab === 'waves' && !collapsed ? 'on' : ''} onClick={() => pick('waves')}>
            WAVES
          </button>
        )}
        {trace.source === 'run' && (
          <button className={tab === 'metrics' && !collapsed ? 'on' : ''} onClick={() => pick('metrics')}>
            METRICS
          </button>
        )}
        <button className={tab === 'problems' && !collapsed ? 'on' : ''} onClick={() => pick('problems')}>
          PROBLEMS{problemCount > 0 ? ` (${problemCount})` : ''}
        </button>
        <div className="spacer" />
        <button className="panel-chevron" title={collapsed ? 'Expand panel' : 'Collapse panel'} onClick={onToggleCollapse}>
          {collapsed ? '⌃' : '⌄'}
        </button>
      </div>
      {!collapsed && (
        <div className="dock-body">
          {tab === 'console' && (
            <div className="console">
              {consoleLines.map((line, i) => (
                <div key={i} className="console-line">
                  {line}
                </div>
              ))}
              {consoleLines.length === 0 && (
                <div className="console-line dim">
                  ▶ Run compiles the design against the engine; ✓ Verify grades it against the spec
                  oracle.
                </div>
              )}
            </div>
          )}
          {tab === 'trace' && (
            <>
              <div className="transport">
                <button onClick={() => (playing ? onPause() : onPlay())} title="Space">
                  {playing ? '⏸' : '▶'}
                </button>
                <button onClick={() => onStep(-1)} title="Step back">
                  ⏮
                </button>
                <button onClick={() => onStep(1)} title="Step forward">
                  ⏭
                </button>
                <input
                  className="scrubber"
                  type="range"
                  min={0}
                  max={Math.max(1, trace.cycles)}
                  step={0.01}
                  value={playhead}
                  onChange={(e) => onScrub(Number(e.target.value))}
                />
                <span className="cycle-badge">
                  cycle {Math.floor(playhead)} / {trace.cycles}
                  {trace.ranCycles !== undefined && trace.ranCycles < trace.cycles
                    ? ` (engine ran ${trace.ranCycles})`
                    : ''}
                  {trace.source === 'synthetic' ? ' (synthetic preview)' : ''}
                </span>
                <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))} title="Speed">
                  <option value={0.25}>0.25×</option>
                  <option value={0.5}>0.5×</option>
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </div>
              <div className="pipeline">
                {occupancy.length === 0 && <div className="dim">no tokens in flight at this cycle</div>}
                {occupancy.map(([id, n]) => (
                  <div key={id} className="pipe-row">
                    <span className="pipe-name" title={id}>
                      {labelOf(id)}
                    </span>
                    <span className="pipe-bar" style={{ width: Math.min(240, n * 48) }} />
                    <span>{n}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {tab === 'pipeline' && (
            <div className="pipe-grid-wrap">
              {pipeline.tokens.length === 0 && (
                <div className="dim">no trace yet — ▶ Run the design to fill the pipeline diagram</div>
              )}
              {pipeline.tokens.length > 0 && (
                <table className="pipe-grid">
                  <thead>
                    <tr>
                      <th className="pipe-token-col">token</th>
                      {Array.from({ length: pipeline.cycles }, (_, c) => {
                        const past = trace.ranCycles !== undefined && c >= trace.ranCycles;
                        return (
                          <th
                            key={c}
                            className={`${Math.floor(playhead) === c ? 'playhead' : ''} ${past ? 'undelivered' : ''}`}
                            onClick={() => onScrub(c)}
                            title={
                              past
                                ? `cycle ${c} — after the clock stop (${trace.ranCycles}): wire-flight only, no handlers ran`
                                : `cycle ${c} — click to scrub`
                            }
                          >
                            {c}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {pipeline.tokens.map((token) => (
                      <tr key={token}>
                        <td className="pipe-token-col">
                          <span
                            className="pipe-token-chip"
                            style={{ background: TOKEN_COLORS[token % TOKEN_COLORS.length] }}
                          />
                          t{token}
                        </td>
                        {Array.from({ length: pipeline.cycles }, (_, c) => {
                          const cell = pipeline.cellAt(token, c);
                          const past = trace.ranCycles !== undefined && c >= trace.ranCycles;
                          if (!cell)
                            return (
                              <td
                                key={c}
                                className={`${Math.floor(playhead) === c ? 'playhead' : ''} ${past ? 'undelivered' : ''}`}
                              />
                            );
                          return (
                            <td
                              key={c}
                              className={`pipe-cell ${cell.inFlight ? 'flight' : ''} ${Math.floor(playhead) === c ? 'playhead' : ''} ${past ? 'undelivered' : ''}`}
                              style={{ background: `hsl(${blockHue(cell.block)} 45% 28% / 0.85)` }}
                              title={`cycle ${c}: token ${token} ${cell.inFlight ? '→ ' : 'in '}${cell.block} (${cell.event})${past ? ' — after the clock stop; never delivered' : ''} — click to scrub`}
                              onClick={() => onPickCell(cell.block, c)}
                            >
                              {cell.inFlight ? `→${labelOf(cell.block)}` : labelOf(cell.block)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {tab === 'waves' && (
            <div className="waves-wrap">
              <WavesView waves={waves} playhead={playhead} onScrub={onScrub} />
            </div>
          )}
          {tab === 'metrics' && (
            <MetricsTab
              trace={trace}
              playhead={playhead}
              labelOf={labelOf}
              timelines={timelines}
              onPickCell={onPickCell}
            />
          )}
          {tab === 'problems' && (
            <div className="console">
              {undelivered.length > 0 && (
                <div
                  className="console-warning"
                  title="click to scrub to the clock stop"
                  onClick={() => onScrub(trace.ranCycles ?? 0)}
                >
                  ⚠ {undelivered.length} event(s) sent but never delivered — the clock stopped at
                  cycle {trace.ranCycles} while arrivals extend to {trace.cycles - 1}. Everything
                  after cycle {trace.ranCycles} is wire-flight only (no handlers ran). Raise{' '}
                  <b>cycles</b> in the run config (⚙▾ next to Run) or shorten the wire latencies:{' '}
                  {[...new Set(undelivered.map((h) => `${h.from} → ${h.to}`))].slice(0, 3).join(', ')}
                  {new Set(undelivered.map((h) => `${h.from} → ${h.to}`)).size > 3 ? ', …' : ''}
                </div>
              )}
              {diagnostics.map((d, i) => (
                <div key={`fd${i}`} className="console-divergence">
                  {d.severity === 'error' ? '⛔' : '⚠'} [design] {d.detail}
                </div>
              ))}
              {divergences.map((d, i) => (
                <div key={`d${i}`} className="console-divergence" onClick={() => onRevealDivergence(d)}>
                  ⚠ {d.provenance === 'cosim' ? '[cosim] ' : ''}
                  {d.provenance === 'drop' ? '[drop] ' : ''}cycle {d.cycle} · {d.component} ·
                  token {d.token} — {d.detail}
                </div>
              ))}
              {problemCount === 0 && (
                <div className="console-line dim">no divergences — design matches the oracle</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
