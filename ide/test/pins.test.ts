// I/O pin blocks: io flag through the model → augment → composite `pins`,
// pin-row geometry on minimized composites, and entry detection.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EMPTY_MODEL, type EditIntent } from '@iss/contracts/model';
import { applyIntent } from '@iss/host/writer/edits';
import { SIDECAR, openModel, writeModel } from '@iss/host/writer/index';
import { parseProject } from '@iss/host/parser/index';
import { augmentWithModel } from '@iss/host/project/augment';
import {
  NODE_HEADER,
  PORT_ROW,
  compositePinAnchor,
  compositePinRows,
  entryBlocksOf,
  nodeHeight,
} from '@iss/canvas/layout';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-pins-'));

/** Unit1 composite with an in-pin → Stage1 → out-pin; the external Feeder
 *  reaches the in-pin through the fabric (router rule — cross-top wires are
 *  not allowed). */
function pinModel() {
  const intents: EditIntent[] = [
    { kind: 'addComponent', id: 'Unit1', label: 'Accelerator', nodeKind: 'composite' },
    { kind: 'addComponent', id: 'Unit1.req', label: 'Request in', io: 'in' },
    { kind: 'addComponent', id: 'Unit1.Stage1' },
    { kind: 'addComponent', id: 'Unit1.resp', label: 'Response out', io: 'out' },
    { kind: 'addComponent', id: 'Feeder' },
    { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
    { kind: 'addEvent', id: 'ReqEvent' },
    { kind: 'addEvent', id: 'WorkEvent' },
    { kind: 'addEvent', id: 'RespEvent' },
    // Outside ⇢ fabric rule ⇢ in-pin → inner stage → out-pin.
    { kind: 'addWire', from: 'Feeder', port: 'out_Feeder', message: 'ReqEvent', latency: 1 },
    { kind: 'setConsumes', id: 'Unit1.req', consumes: ['ReqEvent'] },
    { kind: 'attachRouter', id: 'Feeder', router: 'R0', attach: true },
    { kind: 'attachRouter', id: 'Unit1', router: 'R0', attach: true },
    { kind: 'addForwardingRule', router: 'R0', rule: { message: 'ReqEvent', to: 'Unit1' } },
    { kind: 'addWire', from: 'Unit1.req', port: 'fwd', message: 'WorkEvent', to: 'Unit1.Stage1', latency: 0 },
    { kind: 'addWire', from: 'Unit1.Stage1', port: 'out', message: 'RespEvent', to: 'Unit1.resp', latency: 1 },
  ];
  return intents.reduce(applyIntent, EMPTY_MODEL);
}

describe('I/O pin blocks', () => {
  it('io flag survives reducer → sidecar → load → augment; composites get pins', () => {
    const root = tmp();
    const model = pinModel();
    writeModel(root, model);

    const reloaded = openModel(root).model;
    expect(reloaded.components.find((c) => c.id === 'Unit1.req')?.io).toBe('in');
    expect(reloaded.components.find((c) => c.id === 'Unit1.resp')?.io).toBe('out');
    expect(reloaded.components.find((c) => c.id === 'Unit1.Stage1')?.io).toBeUndefined();

    const graph = augmentWithModel(parseProject([root]), reloaded);
    const unit = graph.components.find((c) => c.id === 'Unit1')!;
    // The composite's minimized fields come from its pin children — with the
    // event each pin carries (in: what it forwards, out: what it collects).
    expect(unit.pins).toEqual([
      { id: 'Unit1.req', io: 'in', label: 'Request in', message: 'WorkEvent' },
      { id: 'Unit1.resp', io: 'out', label: 'Response out', message: 'RespEvent' },
    ]);
    // Everything still round-trips: intra-composite wires Tier-1, the
    // Feeder's fabric-bound port as a routed link into R0.
    expect(graph.links).toHaveLength(3);
    expect(graph.links.filter((l) => l.status === 'wired')).toHaveLength(2);
    const feeder = graph.links.find((l) => l.from === 'Feeder')!;
    expect(feeder.status).toBe('routed');
    expect(feeder.via).toEqual(['R0']);
  });

  it('legacy IO.* leaves get io inferred on load', () => {
    const root = tmp();
    const intents: EditIntent[] = [
      { kind: 'addComponent', id: 'IO', nodeKind: 'composite' },
      { kind: 'addComponent', id: 'IO.irq' },
      { kind: 'addComponent', id: 'Sink' },
      { kind: 'addEvent', id: 'IrqEvent' },
      { kind: 'addWire', from: 'IO.irq', port: 'out_irq', message: 'IrqEvent', latency: 1 },
    ];
    writeModel(root, intents.reduce(applyIntent, EMPTY_MODEL));

    // Make the sidecar genuinely legacy. `writeModel` stamps the current
    // schemaVersion, and the IO.* inference is a v0→v1 migration rung — so it
    // must NOT fire on a file this build just wrote, only on a pre-versioned
    // one. Stripping the stamp is what actually reproduces the old format.
    const file = path.join(root, SIDECAR);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete raw.schemaVersion;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));

    const reloaded = openModel(root).model;
    expect(reloaded.components.find((c) => c.id === 'IO.irq')?.io).toBe('in');
  });

  it('does not re-infer io on a current sidecar', () => {
    // The inference is a migration, not a load-time normalization. Running it
    // on every load meant a modern file could have `io` invented for it.
    const root = tmp();
    const intents: EditIntent[] = [
      { kind: 'addComponent', id: 'IO', nodeKind: 'composite' },
      { kind: 'addComponent', id: 'IO.irq' },
      { kind: 'addEvent', id: 'IrqEvent' },
      { kind: 'addWire', from: 'IO.irq', port: 'out_irq', message: 'IrqEvent', latency: 1 },
    ];
    writeModel(root, intents.reduce(applyIntent, EMPTY_MODEL));
    const reloaded = openModel(root).model;
    expect(reloaded.components.find((c) => c.id === 'IO.irq')?.io).toBeUndefined();
  });

  it('composite pin rows drive node height and boundary anchors', () => {
    const root = tmp();
    const model = pinModel();
    writeModel(root, model);
    const graph = augmentWithModel(parseProject([root]), model);
    const unit = graph.components.find((c) => c.id === 'Unit1')!;
    const layout = { Unit1: { x: 100, y: 200 } };

    const rows = compositePinRows(unit);
    expect(rows.map((p) => p.id)).toEqual(['Unit1.req', 'Unit1.resp']); // in first, then out
    expect(nodeHeight(unit)).toBe(NODE_HEADER + 2 * PORT_ROW + 10);

    const req = compositePinAnchor(unit, layout, 'Unit1.req')!;
    expect(req.x).toBe(100); // in-pin: left edge
    expect(req.y).toBe(200 + NODE_HEADER + PORT_ROW / 2);
    const resp = compositePinAnchor(unit, layout, 'Unit1.resp')!;
    expect(resp.x).toBeGreaterThan(100); // out-pin: right edge
    expect(resp.y).toBe(200 + NODE_HEADER + PORT_ROW + PORT_ROW / 2);
    expect(compositePinAnchor(unit, layout, 'Unit1.Stage1')).toBeNull();
  });

  it('entryBlocksOf: manual entries win; auto finds untargeted leaves', () => {
    const root = tmp();
    const model = pinModel();
    writeModel(root, model);
    const graph = augmentWithModel(parseProject([root]), model);

    // Auto: Feeder is the only leaf nobody sends to.
    expect(entryBlocksOf(graph, [])).toEqual(new Set(['Feeder']));
    // Manual: explicit entries, unknown ids dropped.
    expect(entryBlocksOf(graph, [{ block: 'Unit1.req' }, { block: 'Nope' }])).toEqual(
      new Set(['Unit1.req']),
    );
  });
});
