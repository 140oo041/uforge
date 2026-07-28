// The no-project surface — the first page of the record.
//
// Its job is not to advertise. It is to hand over the one notation the whole
// tool is written in, before anything can refuse an edit: four custody states,
// shown as real strokes at real weight, on a fragment of a real design. An
// architect recognises the grammar; a student learns why a line frays.
//
// Direction contract lives in provenance.css; world in app/DESIGN.md.

import { useEffect, useState } from 'react';


export type { ProjectState } from '../electron/preload';

/** The Custody Rule, verbatim from app/DESIGN.md. */
const LEGEND: Array<{ cls: string; name: string; meaning: string }> = [
  { cls: 'documented', name: 'documented', meaning: 'configureOut exists in the source' },
  { cls: 'attested', name: 'attested', meaning: "a router's rules own the destination" },
  { cls: 'inferred', name: 'inferred', meaning: 'the parser deduced it; nobody wrote it' },
  { cls: 'silent', name: 'silent', meaning: 'no record — a stub, dangling with its reason' },
  { cls: 'disputed', name: 'disputed', meaning: 'points at nothing' },
];

export function Welcome() {
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    void window.iss.state().then((s) => setRecents(s.recents));
    return window.iss.onProjectChange((s) => setRecents(s.recents));
  }, []);

  return (
    <div className="welcome">
      <div className="welcome-grid">
        <section className="welcome-open">
          <h1 className="welcome-name">
            Every design
            <em>has a record.</em>
          </h1>
          <div className="welcome-rule" aria-hidden="true">
            <i />
            <b />
          </div>

          <p className="welcome-what">
            An SoC as a graph of blocks whose real, cycle-accurate C++ is the design
            itself. ISS compiles it, runs it on its own engine, and writes the trace
            back onto the schematic — so what you are looking at is what happened,
            and what it could not prove says so.
          </p>

          <button className="welcome-primary" onClick={() => void window.iss.openProject()}>
            Open project
          </button>
          <p className="welcome-hint">
            The directory holding <code>src/</code> and <code>inc/</code>.
          </p>

          <h2 className="welcome-label">Recent</h2>
          {recents.length === 0 ? (
            <p className="welcome-empty">
              No entries yet. <code>sample/</code> and <code>robot_soc/</code> in this
              repository are both real, runnable designs.
            </p>
          ) : (
            <ul className="welcome-recents">
              {recents.map((dir) => (
                <li key={dir}>
                  <button
                    className="welcome-recent"
                    title={dir}
                    onClick={() => void window.iss.openRecent(dir)}
                  >
                    <span className="welcome-recent-name">{basename(dir)}</span>
                    <span className="welcome-recent-path">{shortenPath(dir)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="welcome-teach">
          <Schematic />
          <h2 className="welcome-label">What a line claims</h2>
          <ul className="welcome-legend">
            {LEGEND.map((row) => (
              <li key={row.cls}>
                <svg className="legend-swatch" viewBox="0 0 58 10" aria-hidden="true">
                  <path className={`w w-${row.cls}`} d="M2 5 H56" />
                </svg>
                <span className="legend-name">{row.name}</span>
                <span className="legend-meaning">{row.meaning}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

/**
 * A real fragment of a design: a traffic generator feeding a router that splits
 * an address range across two memories. Every stroke is one of the five custody
 * states at the weight the bench draws it, so the notation learned here is the
 * notation used there.
 */
function Schematic() {
  const fold = (x: number, y: number, fabric = false) => (
    <rect
      className={fabric ? 'n-fold-fabric' : 'n-fold'}
      x={x - 3.5}
      y={y - 3.5}
      width={7}
      height={7}
      transform={`rotate(45 ${x} ${y})`}
    />
  );

  return (
    <svg
      className="welcome-schematic"
      viewBox="0 0 560 236"
      role="img"
      aria-label="A traffic generator wired to a router that forwards to two memories; one output dangles with no consumer and one points at nothing."
    >
      {/* ribbons first, so the leaves sit on top of their folds */}
      <path className="w w-documented" d="M132 92 H196" />
      <path className="w w-attested" d="M292 84 H330 V44 H366" />
      <path className="w w-attested" d="M292 100 H330 V166 H366" />
      <path className="w w-inferred" d="M62 74 V28 H392 V30" />
      <path className="w w-silent" d="M474 166 H520" />
      <path className="w w-disputed" d="M62 110 V196 H150" />

      {/* Gen */}
      <g>
        <rect className="n-plate" x="8" y="74" width="124" height="36" />
        <line className="n-rule n-rule-doc" x1="9" y1="74" x2="9" y2="110" />
        <text className="n-label" x="22" y="92">Gen</text>
        <text className="n-cat" x="22" y="104">trafficgen</text>
      </g>
      {fold(132, 92)}

      {/* Router */}
      <g>
        <rect className="n-plate" x="196" y="74" width="96" height="36" />
        <line className="n-rule n-rule-fabric" x1="197" y1="74" x2="197" y2="110" />
        <text className="n-label" x="210" y="92">R0</text>
        <text className="n-cat" x="210" y="104">router</text>
      </g>
      {fold(196, 92)}
      {fold(292, 84, true)}
      {fold(292, 100, true)}

      {/* DRAM */}
      <g>
        <rect className="n-plate" x="366" y="26" width="108" height="36" />
        <line className="n-rule n-rule-doc" x1="367" y1="26" x2="367" y2="62" />
        <text className="n-label" x="380" y="44">DRAM</text>
        <text className="n-cat" x="380" y="56">0x0–0xfff</text>
      </g>
      {fold(366, 44, true)}

      {/* SRAM */}
      <g>
        <rect className="n-plate" x="366" y="148" width="108" height="36" />
        <line className="n-rule n-rule-doc" x1="367" y1="148" x2="367" y2="184" />
        <text className="n-label" x="380" y="166">SRAM</text>
        <text className="n-cat" x="380" y="178">0x1000–</text>
      </g>
      {fold(366, 166, true)}

      {/* The stamp: an authority other than the author owns these two edges. */}
      <g transform="translate(300, 116)">
        <rect className="stamp-box" x="0" y="0" width="86" height="22" />
        <text className="stamp-text" x="8" y="14">RULE 1 · R0</text>
      </g>

      <text className="ann ann-silent" x="474" y="154">no consumer</text>
      <text className="ann ann-disputed" x="156" y="200">unresolved</text>
      <text className="ann ann-fabric" x="86" y="22">inferred from rules</text>
    </svg>
  );
}

function basename(dir: string): string {
  const parts = dir.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/**
 * Drop middle segments until the path fits, keeping the root and the last two.
 * Done in JS rather than with `direction: rtl` + ellipsis, because bidi
 * reordering rewrites a POSIX path — it moves the leading slash to the end. A
 * path is a record; it is shown exactly or shortened honestly.
 */
function shortenPath(dir: string, max = 46): string {
  if (dir.length <= max) return dir;

  const sep = dir.includes('\\') ? '\\' : '/';
  const leading = dir.startsWith(sep) ? sep : '';
  const parts = dir.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 3) return dir;

  const tail = parts.slice(-2);
  for (let head = parts.length - 2; head > 0; head--) {
    const candidate = `${leading}${[...parts.slice(0, head), '…', ...tail].join(sep)}`;
    if (candidate.length <= max) return candidate;
  }
  return `${leading}…${sep}${tail.join(sep)}`;
}
