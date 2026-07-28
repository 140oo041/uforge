// VCD subset parser: header directives, scoped names, scalar + vector value
// changes, and graceful skipping of everything else.

import { describe, expect, it } from 'vitest';

import { parseVcd } from '@iss/host/trace/vcd';

const SMALL_VCD = [
  '$date today $end',
  '$version Verilator $end',
  '$timescale 1ps $end',
  '$scope module Alpha $end',
  '$var wire 1 ! clk $end',
  '$var wire 1 " ReqEvent_valid $end',
  '$var wire 32 # ReqEvent_addr [31:0] $end',
  '$upscope $end',
  '$enddefinitions $end',
  '$dumpvars',
  '0!',
  '0"',
  'b0 #',
  '$end',
  '#0',
  '1!',
  '1"',
  'b1010 #',
  '#1',
  '0!',
  '#2',
  '1!',
  '0"',
  'r1.5 $ this real is skipped',
  'garbage line',
  '#3',
  '0!',
].join('\n');

describe('parseVcd', () => {
  it('parses defs, scoped names, scalar and vector changes', () => {
    const doc = parseVcd(SMALL_VCD, 'Alpha');
    expect(doc.block).toBe('Alpha');
    expect(doc.timescale).toBe('1ps');
    expect(doc.maxTime).toBe(3);
    expect(doc.signals).toHaveLength(3);

    const clk = doc.signals.find((s) => s.name === 'Alpha.clk')!;
    expect(clk.width).toBe(1);
    // The $dumpvars block's initial values land at time 0 (pre-#0 changes
    // record at the current time, which starts at 0).
    expect(clk.changes).toEqual([
      { t: 0, v: '0' },
      { t: 0, v: '1' },
      { t: 1, v: '0' },
      { t: 2, v: '1' },
      { t: 3, v: '0' },
    ]);

    const valid = doc.signals.find((s) => s.name === 'Alpha.ReqEvent_valid')!;
    expect(valid.changes.map((c) => c.v)).toEqual(['0', '1', '0']);
    expect(valid.changes[2]).toEqual({ t: 2, v: '0' });

    const addr = doc.signals.find((s) => s.name === 'Alpha.ReqEvent_addr')!;
    expect(addr.width).toBe(32);
    expect(addr.changes).toEqual([
      { t: 0, v: '0' },
      { t: 0, v: '1010' },
    ]);
  });

  it('changes for unknown ids and malformed lines are dropped, never fatal', () => {
    const doc = parseVcd('$enddefinitions $end\n#5\n1?\nbxx\nnonsense\n', 'B');
    expect(doc.signals).toEqual([]);
    // #5 was still consumed as a time marker but nothing recorded → maxTime
    // only advances on a recorded change.
    expect(doc.maxTime).toBe(0);
  });

  it('empty input yields an empty doc', () => {
    const doc = parseVcd('', 'X');
    expect(doc.signals).toEqual([]);
    expect(doc.timescale).toBeNull();
    expect(doc.maxTime).toBe(0);
  });
});
