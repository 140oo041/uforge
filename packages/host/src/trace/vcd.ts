// Hand-rolled VCD subset parser — just enough for Verilator's --trace
// output: $timescale / $scope / $var / $upscope / $enddefinitions in the
// header, then #time markers with scalar (0a) and vector (b1010 a) value
// changes. Reals ('r') and unknown directives are skipped, never fatal —
// a malformed line loses that line, not the document.

import type { WaveDoc, WaveSignal } from '@iss/contracts/waves';

export function parseVcd(text: string, block: string): WaveDoc {
  const signals = new Map<string, WaveSignal>();
  let timescale: string | null = null;
  let maxTime = 0;
  let time = 0;
  let inDefs = true;
  const scope: string[] = [];

  const record = (id: string, v: string) => {
    const sig = signals.get(id);
    if (!sig) return;
    sig.changes.push({ t: time, v });
    if (time > maxTime) maxTime = time;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;

    if (inDefs) {
      const words = line.split(/\s+/);
      switch (words[0]) {
        case '$timescale':
          // Single-line form "$timescale 1ps $end"; multi-line bodies land
          // in the default arm and are ignored harmlessly.
          timescale = words.slice(1).filter((w) => w !== '$end').join(' ') || null;
          break;
        case '$scope':
          if (words[2]) scope.push(words[2]);
          break;
        case '$upscope':
          scope.pop();
          break;
        case '$var': {
          // $var wire 8 a name [7:0] $end
          const width = Number(words[2]);
          const id = words[3];
          const name = words[4];
          if (id && name && Number.isFinite(width))
            signals.set(id, {
              id,
              name: [...scope, name].join('.'),
              width: Math.max(1, Math.floor(width)),
              changes: [],
            });
          break;
        }
        case '$enddefinitions':
          inDefs = false;
          break;
        default:
          break; // $date, $version, $comment bodies, …
      }
      continue;
    }

    const c = line[0];
    if (c === '#') {
      const t = Number(line.slice(1));
      if (Number.isFinite(t)) time = t;
    } else if (c === '0' || c === '1' || c === 'x' || c === 'X' || c === 'z' || c === 'Z') {
      // Scalar change: value char immediately followed by the id code.
      record(line.slice(1), c.toLowerCase());
    } else if (c === 'b' || c === 'B') {
      // Vector change: "b1010 <id>".
      const sp = line.indexOf(' ');
      if (sp > 1) record(line.slice(sp + 1).trim(), line.slice(1, sp).toLowerCase());
    } else if (c === '$') {
      continue; // $dumpvars / $end blocks — value changes inside still parse
    }
    // 'r' reals and anything else: skipped.
  }

  return { block, timescale, maxTime, signals: [...signals.values()] };
}
