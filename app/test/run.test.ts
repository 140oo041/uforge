// The claim the whole product rests on: it runs for real.
//
// This drives the desktop session end to end — author a design through the
// protocol, send `simulate`, and assert that a compiler ran, a binary executed,
// and the trace that came back describes the hops the design actually has.
// Nothing is stubbed; if g++ or the engine library is missing, this fails
// rather than passing on a synthesized trace, because a green test over a fake
// run is exactly the failure this product exists to refuse.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HostMsg, RunStatus } from '@iss/contracts/messaging';
import { EMPTY_MODEL, type EditIntent } from '@iss/contracts/model';
import { applyIntent, writeModel } from '@iss/host';

import { Session } from '../electron/session';

const ENGINE = path.resolve(__dirname, '..', '..', 'engine');

/** A three-stage pipeline inside one composite, seeded from the first stage. */
const FIXTURE: EditIntent[] = [
  { kind: 'addComponent', id: 'CPU0', label: 'Core 0', nodeKind: 'composite' },
  { kind: 'addComponent', id: 'CPU0.IF' },
  { kind: 'addComponent', id: 'CPU0.DE' },
  { kind: 'addComponent', id: 'CPU0.EX' },
  { kind: 'addEvent', id: 'FetchEvent', fields: [{ name: 'pc', type: 'uint32_t' }] },
  { kind: 'addEvent', id: 'DecodeEvent', fields: [] },
  { kind: 'addWire', from: 'CPU0.IF', port: 'out', message: 'FetchEvent', to: 'CPU0.DE', latency: 1 },
  { kind: 'addWire', from: 'CPU0.DE', port: 'out', message: 'DecodeEvent', to: 'CPU0.EX', latency: 1 },
];

describe('desktop run', () => {
  it('compiles the design and returns a trace from the binary it just built', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss-app-run-'));
    writeModel(root, FIXTURE.reduce(applyIntent, EMPTY_MODEL));

    const posted: HostMsg[] = [];
    const session = new Session({
      projectRoot: root,
      enginePath: ENGINE,
      xverifyPath: '',
      sailCommitrecPath: '',
      refModel: 'stub',
      post: (msg) => posted.push(msg),
      openSource: () => {},
    });

    try {
      await session.handle({
        type: 'setRunConfig',
        config: {
          entries: [{ block: 'CPU0.IF', event: 'FetchEvent' }],
          tokens: 3,
          cycles: 64,
          wavesEnabled: false,
          checkDivergence: false,
        },
      });
      posted.length = 0;

      await session.simulate();

      const phases = posted
        .filter((m): m is Extract<HostMsg, { type: 'runlog' }> => m.type === 'runlog')
        .map((m) => m.status)
        .filter((s): s is RunStatus => Boolean(s))
        .map((s) => s.phase);

      // It reported building, then running, then done — and never error.
      expect(phases).toContain('building');
      expect(phases).toContain('running');
      expect(phases[phases.length - 1]).toBe('done');

      // A real binary exists where the Makefile puts it.
      expect(fs.existsSync(path.join(root, 'build', 'design'))).toBe(true);

      const trace = posted.find(
        (m): m is Extract<HostMsg, { type: 'trace' }> => m.type === 'trace',
      )?.trace;
      expect(trace, 'no trace was posted').toBeDefined();
      expect(trace!.source).toBe('run');
      expect(trace!.hops.length).toBeGreaterThan(0);

      // The hops describe the pipeline that was actually authored.
      const pairs = new Set(trace!.hops.map((h) => `${h.from}->${h.to}`));
      expect(pairs).toContain('CPU0.IF->CPU0.DE');
      expect(pairs).toContain('CPU0.DE->CPU0.EX');
    } finally {
      session.dispose();
    }
  }, 180_000);
});
