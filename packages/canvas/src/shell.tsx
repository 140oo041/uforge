// VS Code-style shell chrome: activity bar (far-left icon rail), editor tab
// strip, and status bar. Pure presentational — all state lives in App.

import type { RunStatus, SailStatus } from '@iss/contracts/messaging';
import { displayCycle, displayCycles, formatTime, type Trace } from '@iss/contracts/trace';

export type EditorTab = 'design' | 'spec' | 'events';

export function ActivityBar({
  active,
  onSelect,
  onTogglePanel,
}: {
  active: EditorTab;
  onSelect(tab: EditorTab): void;
  onTogglePanel(): void;
}) {
  return (
    <nav className="activity-bar">
      <button
        className={active === 'design' ? 'on' : ''}
        title="Design canvas"
        onClick={() => onSelect('design')}
      >
        ▦
      </button>
      <button
        className={active === 'events' ? 'on' : ''}
        title="Messages — the design's packet vocabulary"
        onClick={() => onSelect('events')}
      >
        ✉
      </button>
      <button
        className={active === 'spec' ? 'on' : ''}
        title="Architecture SPEC"
        onClick={() => onSelect('spec')}
      >
        ⚙
      </button>
      <div className="activity-spacer" />
      <button title="Toggle panel" onClick={onTogglePanel}>
        ▤
      </button>
    </nav>
  );
}

export function TabBar({
  active,
  runConfigOpen,
  onSelect,
  onRun,
  onToggleRunConfig,
  onVerify,
}: {
  active: EditorTab;
  runConfigOpen: boolean;
  onSelect(tab: EditorTab): void;
  onRun(): void;
  onToggleRunConfig(): void;
  onVerify(): void;
}) {
  const tab = (id: EditorTab, label: string) => (
    <button className={`editor-tab ${active === id ? 'on' : ''}`} onClick={() => onSelect(id)}>
      {label}
    </button>
  );
  return (
    <div className="tab-bar">
      {tab('design', '▦ Design')}
      {tab('events', '✉ Messages')}
      {tab('spec', '⚙ SPEC')}
      <div className="spacer" />
      <div className="tab-actions">
        <button className="run" title="Compile & run on the engine" onClick={onRun}>
          ▶ Run
        </button>
        <button
          className={`run-cfg ${runConfigOpen ? 'on' : ''}`}
          title="Run configuration — entry blocks, seed event, tokens, cycles"
          onClick={onToggleRunConfig}
        >
          ⚙▾
        </button>
        <button className="verify" title="Cross-verify against the spec oracle" onClick={onVerify}>
          ✓ Verify
        </button>
      </div>
    </div>
  );
}

export function StatusBar({
  runStatus,
  sail,
  ticks,
  ranTicks,
  trace,
  playhead,
  currentPath,
  specName,
}: {
  runStatus: RunStatus;
  sail: SailStatus | null;
  /** Timeline length in TICKS. Displayed as reference-domain cycles. */
  ticks: number;
  ranTicks?: number;
  trace: Trace;
  playhead: number;
  currentPath: string | null;
  specName: string | null;
}) {
  return (
    <footer className="status-bar">
      <span className={`sb-item sb-phase sb-${runStatus.phase}`}>
        {runStatus.phase === 'idle' ? '○' : runStatus.phase === 'error' ? '✗' : '●'}{' '}
        {runStatus.phase}
      </span>
      {sail && (
        <span
          className={`sb-item ${sail.lastRun ? (sail.lastRun.ok ? 'sb-ok' : 'sb-err') : ''}`}
          title={sail.why ?? 'reference oracle'}
        >
          oracle: {sail.ref}
          {sail.lastRun ? (sail.lastRun.ok ? ` ✓ ${sail.lastRun.matched}` : ' ✗ diverged') : ''}
        </span>
      )}
      {specName && <span className="sb-item">spec: {specName}</span>}
      <span className="spacer" />
      {ticks > 0 && (
        <span
          className={`sb-item ${ranTicks !== undefined && ranTicks < ticks ? 'sb-warn' : ''}`}
          title={
            ranTicks !== undefined && ranTicks < ticks
              ? `engine stopped at cycle ${displayCycle(trace, ranTicks)}; arrivals extend to ${displayCycles(trace) - 1} (undelivered — see PROBLEMS)`
              : undefined
          }
        >
          cycle {displayCycle(trace, playhead)} / {displayCycles(trace)}
          {formatTime(trace, playhead) ? ` · ${formatTime(trace, playhead)}` : ''}
          {ranTicks !== undefined && ranTicks < ticks
            ? ` ⚠ ran ${displayCycle(trace, ranTicks)}`
            : ''}
        </span>
      )}
      <span className="sb-item">{currentPath ? `▸ ${currentPath}` : '▸ design'}</span>
    </footer>
  );
}
