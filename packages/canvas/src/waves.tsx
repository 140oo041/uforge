// WAVES panel tab: one SVG lane per VCD signal of the selected SV block.
// Bit signals render as step edges, vectors as value blocks with hex text.
// The shared playhead maps to VCD time via the adapter's dump scheme
// (time = 2*cycle posedge / 2*cycle+1 negedge), so scrubbing here moves the
// same cursor as the TRACE transport and PIPELINE grid.

import { useMemo, useState } from 'react';

import type { WaveDoc, WaveSignal } from '@iss/contracts/waves';

const PX_PER_TIME = 14; // half-cycle width
const LANE_H = 26;
const WAVE_H = 14;
const NAME_W = 190;

interface Props {
  waves: WaveDoc[];
  playhead: number;
  onScrub(cycle: number): void;
}

/** Value of a signal at time t (last change ≤ t), or null before the first. */
function valueAt(sig: WaveSignal, t: number): string | null {
  let v: string | null = null;
  for (const ch of sig.changes) {
    if (ch.t > t) break;
    v = ch.v;
  }
  return v;
}

function hexOf(bits: string): string {
  if (/[xz]/.test(bits)) return bits.length > 8 ? 'x…' : bits;
  const n = Number.parseInt(bits, 2);
  return Number.isFinite(n) ? '0x' + n.toString(16) : bits;
}

function BitLane({ sig, width }: { sig: WaveSignal; width: number }) {
  const y0 = (LANE_H + WAVE_H) / 2; // low rail
  const y1 = (LANE_H - WAVE_H) / 2; // high rail
  const yOf = (v: string) => (v === '1' ? y1 : y0);
  let d = '';
  let prev: string | null = null;
  for (const ch of sig.changes) {
    const x = ch.t * PX_PER_TIME;
    if (prev === null) d += `M ${x} ${yOf(ch.v)}`;
    else d += ` L ${x} ${yOf(prev)} L ${x} ${yOf(ch.v)}`;
    prev = ch.v;
  }
  if (prev !== null) d += ` L ${width} ${yOf(prev)}`;
  return <path className="wave-bit" d={d} fill="none" />;
}

function VectorLane({ sig, width }: { sig: WaveSignal; width: number }) {
  const spans: Array<{ x0: number; x1: number; v: string }> = [];
  for (let i = 0; i < sig.changes.length; i++) {
    const x0 = sig.changes[i].t * PX_PER_TIME;
    const x1 = i + 1 < sig.changes.length ? sig.changes[i + 1].t * PX_PER_TIME : width;
    if (x1 > x0) spans.push({ x0, x1, v: sig.changes[i].v });
  }
  return (
    <>
      {spans.map((s, i) => (
        <g key={i}>
          <rect
            className="wave-vec"
            x={s.x0}
            y={(LANE_H - WAVE_H) / 2}
            width={s.x1 - s.x0}
            height={WAVE_H}
            rx={2}
          />
          {s.x1 - s.x0 > 30 && (
            <text className="wave-val" x={(s.x0 + s.x1) / 2} y={LANE_H / 2 + 3.5}>
              {hexOf(s.v)}
            </text>
          )}
        </g>
      ))}
    </>
  );
}

export function WavesView({ waves, playhead, onScrub }: Props) {
  const [blockIdx, setBlockIdx] = useState(0);
  const doc = waves[Math.min(blockIdx, waves.length - 1)];
  const signals = useMemo(
    () => (doc ? [...doc.signals].filter((s) => s.changes.length > 0) : []),
    [doc],
  );

  if (!doc)
    return <div className="dim">no waveforms — enable "record VCD waveforms" in ⚙▾ and Run with an SV block</div>;

  const width = Math.max((doc.maxTime + 2) * PX_PER_TIME, 60);
  const cursorX = playhead * 2 * PX_PER_TIME;
  const scrubTo = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onScrub(Math.max(0, (e.clientX - rect.left) / PX_PER_TIME / 2));
  };

  return (
    <div className="waves">
      <div className="waves-head">
        {waves.length > 1 && (
          <select value={blockIdx} onChange={(e) => setBlockIdx(Number(e.target.value))}>
            {waves.map((w, i) => (
              <option key={w.block} value={i}>
                {w.block}
              </option>
            ))}
          </select>
        )}
        {waves.length === 1 && <span className="waves-block">{doc.block}</span>}
        <span className="dim"> · {signals.length} signals · cycle {Math.floor(playhead)}</span>
      </div>
      <div className="waves-body">
        <div className="waves-names">
          {signals.map((s) => {
            const v = valueAt(s, Math.floor(playhead) * 2);
            return (
              <div key={s.id} className="waves-name" style={{ height: LANE_H }} title={s.name}>
                <span className="waves-name-label">{s.name}</span>
                <span className="waves-name-val">{v === null ? '' : s.width > 1 ? hexOf(v) : v}</span>
              </div>
            );
          })}
        </div>
        <div className="waves-lanes" style={{ width: NAME_W ? undefined : width }}>
          <svg
            width={width}
            height={signals.length * LANE_H}
            onClick={scrubTo}
            style={{ display: 'block', cursor: 'crosshair' }}
          >
            {signals.map((s, i) => (
              <g key={s.id} transform={`translate(0 ${i * LANE_H})`}>
                {s.width > 1 ? <VectorLane sig={s} width={width} /> : <BitLane sig={s} width={width} />}
              </g>
            ))}
            <line
              className="wave-cursor"
              x1={cursorX}
              x2={cursorX}
              y1={0}
              y2={signals.length * LANE_H}
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
