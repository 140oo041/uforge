// Run configuration: persistence round-trip, harness seeding (manual entries
// vs the auto heuristic), and tokens/cycles plumbing.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EMPTY_MODEL, type EditIntent } from '@iss/contracts/model';
import { DEFAULT_RUN_CONFIG, normalizeRunConfig } from '@iss/contracts/runConfig';
import { loadRunConfig, saveRunConfig } from '@iss/host/project/runFile';
import { applyIntent } from '@iss/host/writer/edits';
import { emitHarness } from '@iss/host/writer/harness';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-run-'));

function pipelineModel() {
  // Wires live INSIDE a top-level unit (cross-top wires are not allowed).
  const intents: EditIntent[] = [
    { kind: 'addComponent', id: 'Sys', nodeKind: 'composite' },
    { kind: 'addComponent', id: 'Sys.A' },
    { kind: 'addComponent', id: 'Sys.B' },
    { kind: 'addComponent', id: 'Sys.C' },
    { kind: 'addEvent', id: 'PingEvent' },
    { kind: 'addEvent', id: 'PongEvent' },
    { kind: 'addWire', from: 'Sys.A', port: 'out_A_to_B', message: 'PingEvent', to: 'Sys.B', latency: 1 },
    { kind: 'addWire', from: 'Sys.B', port: 'out_B_to_C', message: 'PongEvent', to: 'Sys.C', latency: 1 },
  ];
  return intents.reduce(applyIntent, EMPTY_MODEL);
}

describe('run config persistence', () => {
  it('round-trips and defaults when missing', () => {
    const root = tmp();
    expect(loadRunConfig(root)).toEqual(DEFAULT_RUN_CONFIG);
    const config = {
      entries: [{ block: 'B', event: 'PongEvent' }],
      tokens: 3,
      cycles: 32,
      wavesEnabled: false,
      checkDivergence: true,
    };
    saveRunConfig(root, config);
    expect(loadRunConfig(root)).toEqual(config);
  });

  it('normalizes junk (bad numbers, malformed entries)', () => {
    const normalized = normalizeRunConfig({
      entries: [{ block: 'A' }, { nope: true }, null, { block: 'B', event: 7 }],
      tokens: -3,
      cycles: 'many',
      wavesEnabled: 'yes',
    });
    expect(normalized).toEqual({
      entries: [
        { block: 'A', event: null },
        { block: 'B', event: null },
      ],
      tokens: 8,
      cycles: 64,
      wavesEnabled: true, // anything but literal false means on
      checkDivergence: false, // anything but literal true means off
    });
  });
});

describe('harness seeding', () => {
  it('auto mode seeds the leaves nobody sends to', () => {
    const harness = emitHarness(pipelineModel());
    // A has no inbound wire → the sole auto entry; seeds its consumed event
    // (none → generic Event).
    expect(harness).toContain('auto-detected');
    expect(harness).toContain('scheduler.seed(std::make_unique<microarch::Event>("Event"), s_Sys_A, c);');
    expect(harness).not.toContain(', s_Sys_B, c);');
  });

  it('manual entries seed exactly the configured blocks/events/tokens/cycles', () => {
    const harness = emitHarness(pipelineModel(), {
      tokens: 3,
      cycles: 32,
      entries: [
        { block: 'Sys.B', event: 'PongEvent' },
        { block: 'Gone', event: null }, // deleted block — skipped with a comment
      ],
    });
    expect(harness).toContain('from iss_run.json');
    expect(harness).toContain('c < 3');
    expect(harness).toContain(': 32;'); // default cycle budget
    expect(harness).toContain('scheduler.seed(std::make_unique<PongEvent>(), s_Sys_B, c);');
    expect(harness).not.toContain(', s_Sys_A, c);');
    expect(harness).toContain("run-config entry 'Gone' not found — skipped.");
  });

  it('manual entry with event=null falls back to the block’s consumed event', () => {
    const harness = emitHarness(pipelineModel(), {
      entries: [{ block: 'Sys.C', event: null }],
    });
    // C consumes PongEvent (added by addWire).
    expect(harness).toContain('scheduler.seed(std::make_unique<PongEvent>(), s_Sys_C, c);');
  });
});
