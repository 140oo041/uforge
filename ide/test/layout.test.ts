// Canvas geometry: in-port rows (consumed events listed on the input side),
// anchor math with in-rows stacked above out-rows, and node height.

import { describe, expect, it } from 'vitest';

import type { GraphComponent } from '@iss/contracts/graph';
import {
  NODE_HEADER,
  NODE_WIDTH,
  PORT_ROW,
  fabricGeoEdges,
  inPortAnchor,
  inRowsOf,
  nodeHeight,
  outPortAnchor,
} from '@iss/canvas/layout';

const range = (file: string) => ({ file, line: 1, col: 1, endLine: 1, endCol: 1 });

function leaf(overrides: Partial<GraphComponent>): GraphComponent {
  return {
    id: 'DE',
    label: 'DE',
    kind: 'leaf',
    parent: null,
    language: 'cpp',
    decl: range('DE.cpp'),
    outPorts: [],
    consumes: [],
    vars: [],
    ...overrides,
  };
}

describe('in-port rows', () => {
  const de = leaf({
    consumes: ['StallEvent', 'FetchEvent'],
    outPorts: [{ name: 'out_DE_to_EX', message: 'DecodeEvent', latency: 1, decl: range('DE.cpp') }],
  });
  const layout = { DE: { x: 100, y: 200 } };

  it('inRowsOf lists consumed events sorted; composites have none', () => {
    expect(inRowsOf(de)).toEqual(['FetchEvent', 'StallEvent']);
    expect(inRowsOf(leaf({ kind: 'composite', consumes: ['X'] }))).toEqual([]);
  });

  it('in-rows anchor on the left edge at their row; unknown message → null', () => {
    const fetch = inPortAnchor(de, layout, 'FetchEvent')!;
    expect(fetch.x).toBe(100);
    expect(fetch.y).toBe(200 + NODE_HEADER + PORT_ROW / 2);
    const stall = inPortAnchor(de, layout, 'StallEvent')!;
    expect(stall.y).toBe(200 + NODE_HEADER + PORT_ROW + PORT_ROW / 2);
    expect(inPortAnchor(de, layout, 'NopeEvent')).toBeNull();
  });

  it('out-ports anchor below the in-rows on the right edge', () => {
    const out = outPortAnchor(de, layout, 'out_DE_to_EX');
    expect(out.x).toBe(100 + NODE_WIDTH);
    // 2 in-rows stack above the first out-port row.
    expect(out.y).toBe(200 + NODE_HEADER + 2 * PORT_ROW + PORT_ROW / 2);
  });

  it('nodeHeight counts in-rows + out-rows', () => {
    const bare = leaf({});
    expect(nodeHeight(de) - nodeHeight(bare)).toBe(2 * PORT_ROW); // 3 rows vs min 1
  });
});

describe('fabricGeoEdges', () => {
  it('yields center-to-center segments for attachments and trunks', () => {
    const boxes = new Map([
      ['A', { x: 0, y: 0, w: 100, h: 50 }],
      ['R0', { x: 200, y: 0, w: 100, h: 50 }],
      ['R1', { x: 400, y: 100, w: 100, h: 50 }],
    ]);
    const edges = fabricGeoEdges(
      {
        attachments: [
          { component: 'A', router: 'R0' },
          { component: 'Gone', router: 'R0' }, // unplaced — skipped
        ],
        trunks: [{ a: 'R0', b: 'R1' }],
      },
      (id) => boxes.get(id) ?? null,
    );
    expect(edges).toEqual([
      { aId: 'A', bId: 'R0', a: { x: 50, y: 25 }, b: { x: 250, y: 25 }, kind: 'attach' },
      { aId: 'R0', bId: 'R1', a: { x: 250, y: 25 }, b: { x: 450, y: 125 }, kind: 'trunk' },
    ]);
  });

  it('is empty without a fabric', () => {
    expect(fabricGeoEdges(undefined, () => null)).toEqual([]);
  });
});
