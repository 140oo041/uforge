// Packet widths and bit-metered bandwidth. Bandwidth used to be counted in
// packets per cycle, which assumed every packet costs the same; it is now bits,
// and a packet costs the width of what it declares. These tests pin the three
// places that has to stay consistent: the derivation (contracts), what the
// generated C++ carries (writer), and what happens to sidecars written under
// the old units (loadModel).

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_BANDWIDTH_BITS,
  DEFAULT_EVENT_BITS,
  eventBits,
  formatBits,
  typeBits,
} from '@iss/contracts/bits';
import { EMPTY_MODEL, type AuthoringModel, type EditIntent } from '@iss/contracts/model';
import type { SpecDocument } from '@iss/contracts/spec';
import { applyIntent } from '@iss/host/writer/edits';
import { emitEventsHeaderBody } from '@iss/host/writer/blockfile';
import { emitRouterBody } from '@iss/host/writer/routerfile';
import { loadModel, writeModel, SIDECAR } from '@iss/host/writer/index';
import { parseProject } from '@iss/host/parser/index';
import { augmentWithModel } from '@iss/host/project/augment';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-bits-'));
const build = (intents: EditIntent[]): AuthoringModel => intents.reduce(applyIntent, EMPTY_MODEL);

describe('packet width', () => {
  it('derives a width from the declared field types', () => {
    expect(typeBits('uint8_t')).toBe(8);
    expect(typeBits('uint64_t')).toBe(64);
    expect(typeBits('bool')).toBe(1);
    // An array field costs its element width times its length.
    expect(typeBits('uint32_t[8]')).toBe(256);
    expect(
      eventBits({
        fields: [
          { name: 'addr', type: 'uint64_t' },
          { name: 'data', type: 'uint32_t[4]' },
          { name: 'valid', type: 'bool' },
        ],
      }),
    ).toBe(64 + 128 + 1);
  });

  it('charges a payload-free notification one default word', () => {
    expect(eventBits({ fields: [] })).toBe(DEFAULT_EVENT_BITS);
  });

  it('resolves spec aliases and signal enums down to a builtin', () => {
    const spec = {
      name: 'x',
      kind: 'custom',
      types: [{ name: 'word', base: 'addr_t' }, { name: 'addr_t', base: 'uint64_t' }],
      signals: [{ name: 'Op', underlying: 'uint8_t', values: ['A', 'B'] }],
      state: [],
      operations: [],
    } as unknown as SpecDocument;
    expect(typeBits('word', spec)).toBe(64); // two alias hops
    expect(typeBits('Op', spec)).toBe(8);
    // Nothing known about it — charged the default word rather than zero, so
    // an unrecognized type can never make a packet free.
    expect(typeBits('MysteryStruct', spec)).toBe(DEFAULT_EVENT_BITS);
  });

  it('lets an explicit width override the derivation', () => {
    const fields = [{ name: 'a', type: 'uint8_t' }];
    expect(eventBits({ fields })).toBe(8);
    expect(eventBits({ fields, bits: 512 })).toBe(512);
  });

  it('formats widths for the panel', () => {
    expect(formatBits(96)).toBe('96 b');
    expect(formatBits(2048)).toBe('2 kb');
  });
});

describe('generated code carries the width', () => {
  it('bakes the derived width into the event class', () => {
    const body = emitEventsHeaderBody([
      { id: 'Fill', fields: [{ name: 'data', type: 'uint64_t' }, { name: 'tag', type: 'uint8_t' }] },
      { id: 'Ping', fields: [] },
    ]);
    expect(body).toContain('Fill() : Event("Fill") { bits = 72; }');
    expect(body).toContain(`Ping() : Event("Ping") { bits = ${DEFAULT_EVENT_BITS}; }`);
  });

  it('emits setBandwidth in bits, and only when it differs from the default', () => {
    let m = build([{ kind: 'addComponent', id: 'R0', nodeKind: 'router' }]);
    expect(emitRouterBody(m.components[0], m)).not.toContain('setBandwidth');

    m = applyIntent(m, { kind: 'setRouterBandwidth', id: 'R0', bandwidthBits: 256 });
    expect(emitRouterBody(m.components.find((c) => c.id === 'R0')!, m)).toContain(
      'setBandwidth(256);',
    );
  });
});

describe('the read-model', () => {
  it('annotates events with their width, through write → parse → augment', () => {
    const root = tmp();
    const m = build([
      { kind: 'addComponent', id: 'A' },
      {
        kind: 'addEvent',
        id: 'Fill',
        fields: [{ name: 'data', type: 'uint32_t' }, { name: 'tag', type: 'uint16_t' }],
      },
    ]);
    writeModel(root, m);
    const graph = augmentWithModel(parseProject([root]), m);
    expect(graph.events.find((e) => e.id === 'Fill')?.bits).toBe(48);
    expect(graph.events.find((e) => e.id === 'Fill')?.bitsOverridden).toBeUndefined();
  });

  it('marks an authored width as overridden', () => {
    const root = tmp();
    let m = build([
      { kind: 'addComponent', id: 'A' },
      { kind: 'addEvent', id: 'Ping', fields: [] },
    ]);
    m = applyIntent(m, { kind: 'setEventBits', id: 'Ping', bits: 512 });
    writeModel(root, m);
    const graph = augmentWithModel(parseProject([root]), m);
    const ping = graph.events.find((e) => e.id === 'Ping')!;
    expect(ping.bits).toBe(512);
    expect(ping.bitsOverridden).toBe(true);

    // Clearing returns to the derivation rather than to some remembered number.
    m = applyIntent(m, { kind: 'setEventBits', id: 'Ping', bits: null });
    expect(m.events.find((e) => e.id === 'Ping')?.bits).toBeUndefined();
  });
});

describe('legacy sidecars', () => {
  it('converts packet-per-cycle bandwidth to bits at the rate the old model implied', () => {
    const root = tmp();
    // A sidecar written before bandwidth was bits: 3 packets per port per cycle.
    fs.writeFileSync(
      path.join(root, SIDECAR),
      JSON.stringify({
        components: [
          {
            id: 'R0',
            label: 'R0',
            kind: 'router',
            parent: null,
            outPorts: [],
            consumes: [],
            vars: [],
            portBandwidth: 3,
          },
        ],
        events: [],
      }),
    );
    const loaded = loadModel(root)!;
    const r0 = loaded.components.find((c) => c.id === 'R0')!;
    expect(r0.portBandwidthBits).toBe(3 * DEFAULT_EVENT_BITS);
    expect((r0 as { portBandwidth?: number }).portBandwidth).toBeUndefined();
    // The old default (1 packet) lands on the new default (one word).
    expect(DEFAULT_BANDWIDTH_BITS).toBe(DEFAULT_EVENT_BITS);
  });
});
