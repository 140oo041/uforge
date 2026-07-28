// Runs INSIDE the real Extension Development Host (plain CJS — no bundler).
// Executes iss2.runSimulation against the fixture workspace and asserts the
// three v7 features from their on-disk artifacts:
//   - waves:      build/waves/A.vcd exists, non-trivial
//   - cosim:      iss_trace.jsonl carries {"diverge":true,...,"kind":"cosim"}
//   - fabric:     hops go A→R0 and R0→B (the wire names B, transport rides R0)

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, predicate, timeoutMs, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

exports.run = async function run() {
  const fixture = process.env.ISS2_FIXTURE;
  assert.ok(fixture && fs.existsSync(fixture), 'fixture workspace missing');
  console.log('[suite] fixture:', fixture);

  // onStartupFinished activation — wait until the extension registered its
  // commands rather than racing it.
  await waitFor(
    'iss2.runSimulation command registration',
    async () => (await vscode.commands.getCommands(true)).includes('iss2.runSimulation'),
    60_000,
    500,
  );

  console.log('[suite] running iss2.runSimulation (verilate + g++ + execute)…');
  await vscode.commands.executeCommand('iss2.runSimulation');

  // The command awaits the whole pipeline, but be generous: poll artifacts.
  const traceFile = path.join(fixture, 'iss_trace.jsonl');
  await waitFor('iss_trace.jsonl', () => fs.existsSync(traceFile), 300_000, 2000);
  const lines = fs
    .readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  // Fabric: transport rides the router — first legs A→R0, then R0→B.
  const hops = lines.filter((o) => o.from !== undefined && o.to !== undefined);
  assert.ok(
    hops.some((h) => h.from === 'A' && h.to === 'R0'),
    'expected A→R0 hops (fabric interposition)',
  );
  assert.ok(
    hops.some((h) => h.from === 'R0' && h.to === 'B'),
    'expected R0→B hops (router forwarding)',
  );
  assert.ok(
    !hops.some((h) => h.from === 'A' && h.to === 'B'),
    'A must not deliver straight to B when both are attached',
  );

  // Cosim divergence check: the HALVER twin disagrees with the C++ echo.
  const cosim = lines.filter((o) => o.diverge === true && o.kind === 'cosim');
  assert.ok(cosim.length > 0, 'expected cosim divergence records');
  assert.ok(
    cosim.every((d) => d.component === 'A'),
    'cosim divergences localize to A',
  );

  // Waves: the adapter dumped a real VCD.
  const vcd = path.join(fixture, 'build', 'waves', 'A.vcd');
  assert.ok(fs.existsSync(vcd), 'expected build/waves/A.vcd');
  const vcdText = fs.readFileSync(vcd, 'utf8');
  assert.ok(vcdText.includes('$enddefinitions'), 'VCD has definitions');
  assert.ok(vcdText.includes('ReqEvent_valid'), 'VCD carries the twin input strobe');
  assert.ok(/#\d/.test(vcdText), 'VCD has time-stamped value changes');

  console.log(
    `[suite] OK — ${hops.length} hops (via R0), ${cosim.length} cosim divergence(s), ` +
      `VCD ${vcdText.length} bytes`,
  );
};
