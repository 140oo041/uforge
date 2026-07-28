// Run configuration popover (⚙ next to ▶ Run): what the sim runs and where
// it starts — entry block(s), seed event, tokens, cycles. Persists to
// <project>/iss_run.json via the setRunConfig message; the harness generator
// consumes it. "auto" mirrors the harness heuristic (leaves nobody sends to).

import { useState } from 'react';

import type { Graph } from '@iss/contracts/graph';
import type { RunConfig, SeedSpec } from '@iss/contracts/runConfig';
import { entryBlocksOf } from './layout';

interface Props {
  config: RunConfig;
  graph: Graph;
  onSave(config: RunConfig): void;
  onClose(): void;
}

export function RunConfigPanel({ config, graph, onSave, onClose }: Props) {
  const [entries, setEntries] = useState<SeedSpec[]>(config.entries);
  const [tokens, setTokens] = useState(config.tokens);
  const [cycles, setCycles] = useState(config.cycles);
  const [wavesEnabled, setWavesEnabled] = useState(config.wavesEnabled);
  const [checkDivergence, setCheckDivergence] = useState(config.checkDivergence);

  const leaves = graph.components
    .filter((c) => c.kind === 'leaf')
    .sort((a, b) => a.id.localeCompare(b.id));
  const autoDetected = [...entryBlocksOf(graph, [])].sort();

  const setEntry = (index: number, patch: Partial<SeedSpec>) =>
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)));

  const save = () => {
    onSave({
      entries: entries.filter((e) => e.block !== ''),
      tokens: Math.max(1, tokens),
      cycles: Math.max(1, cycles),
      wavesEnabled,
      checkDivergence,
    });
    onClose();
  };

  const eventAutoFor = (block: string): string => {
    const comp = graph.components.find((c) => c.id === block);
    return comp?.consumes[0] ?? 'generic Event';
  };

  return (
    <div className="run-config" onPointerDown={(e) => e.stopPropagation()}>
      <div className="cf-title">Run configuration</div>
      <p className="ins-note">
        Seeds {tokens} token{tokens === 1 ? '' : 's'} (one per cycle) into each entry block, then
        runs {cycles} cycles. Persists to <code>iss_run.json</code>.
      </p>

      <h4>Entry blocks</h4>
      {entries.length === 0 && (
        <p className="ins-note" title={autoDetected.join(', ') || 'none'}>
          auto — blocks nothing sends to: <b>{autoDetected.join(', ') || '(none found)'}</b>
        </p>
      )}
      {entries.map((entry, i) => (
        <div key={i} className="isa-add">
          <select value={entry.block} onChange={(e) => setEntry(i, { block: e.target.value })}>
            <option value="">— pick block —</option>
            {leaves.map((c) => (
              <option key={c.id} value={c.id}>
                {c.io ? `⇥ ${c.label} — ${c.id}` : c.id}
              </option>
            ))}
          </select>
          <select
            value={entry.event ?? ''}
            onChange={(e) => setEntry(i, { event: e.target.value || null })}
            title="seed event"
          >
            <option value="">auto ({entry.block ? eventAutoFor(entry.block) : '…'})</option>
            {graph.events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.id}
              </option>
            ))}
          </select>
          <button
            className="isa-remove"
            title="remove entry"
            onClick={() => setEntries((prev) => prev.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="isa-add">
        <button onClick={() => setEntries((prev) => [...prev, { block: '', event: null }])}>
          ＋ entry
        </button>
        {entries.length > 0 && (
          <button className="ghost" onClick={() => setEntries([])} title="back to auto-detection">
            use auto
          </button>
        )}
      </div>

      <div className="isa-add">
        <span className="ins-key">tokens</span>
        <input
          className="isa-bits"
          type="number"
          min={1}
          value={tokens}
          onChange={(e) => setTokens(Math.max(1, Number(e.target.value) || 1))}
        />
        <span className="ins-key">cycles</span>
        <input
          className="isa-bits"
          type="number"
          min={1}
          value={cycles}
          onChange={(e) => setCycles(Math.max(1, Number(e.target.value) || 1))}
        />
      </div>

      <div className="isa-add">
        <label title="each SV-impl block dumps build/waves/<id>.vcd — see the WAVES panel tab">
          <input
            type="checkbox"
            checked={wavesEnabled}
            onChange={(e) => setWavesEnabled(e.target.checked)}
          />{' '}
          record VCD waveforms (SV blocks)
        </label>
      </div>
      <div className="isa-add">
        <label title="every SV block also runs its C++ implementation in shadow; per-token output mismatches land in PROBLEMS">
          <input
            type="checkbox"
            checked={checkDivergence}
            onChange={(e) => setCheckDivergence(e.target.checked)}
          />{' '}
          divergence check: run C++ shadow for ALL SV blocks
        </label>
      </div>

      <div className="cf-actions">
        <button onClick={save}>Save</button>
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
