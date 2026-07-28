// @vitest-environment happy-dom
// Adding boundary I/O pins from the composite structures view (outside the
// composite): the on-node "+ in"/"+ out" overlay and the inspector's
// "Boundary pins" section both emit the same addComponent intent a palette
// drop while drilled-in would — a nested-id leaf with io set.

import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CanvasApp, windowMessageTransport } from '@iss/canvas';
import { parseProject } from '@iss/host/parser/index';
import { writeModel } from '@iss/host/writer/index';
import { applyIntent } from '@iss/host/writer/edits';
import { augmentWithModel } from '@iss/host/project/augment';
import { EMPTY_MODEL, type EditIntent } from '@iss/contracts/model';
import type { HostMsg } from '@iss/contracts/messaging';

const FIXTURE: EditIntent[] = [
  { kind: 'addComponent', id: 'Unit1', label: 'Accelerator', nodeKind: 'composite' },
  { kind: 'addComponent', id: 'Unit1.req', label: 'Request in', io: 'in' },
  { kind: 'addComponent', id: 'Unit1.Stage1' },
  { kind: 'addComponent', id: 'Feeder' },
  { kind: 'addEvent', id: 'ReqEvent' },
  // Fabric-bound (cross-top wires are not allowed) — incidental to these tests.
  { kind: 'addWire', from: 'Feeder', port: 'out', message: 'ReqEvent', latency: 1 },
  { kind: 'setConsumes', id: 'Unit1.req', consumes: ['ReqEvent'] },
];

// Capture canvas → host posts. The transport is the seam, so collecting them
// is now just a function argument — no global stub, and no dependence on when
// a module happened to resolve it.
const posted: Array<{ type: string; intent?: unknown }> = [];
const TEST_TRANSPORT = windowMessageTransport((msg) =>
  posted.push(msg as { type: string; intent?: unknown }),
);

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-addpin-'));
  const model = FIXTURE.reduce(applyIntent, EMPTY_MODEL);
  writeModel(root, model);
  const graph = augmentWithModel(parseProject([root]), model);
  const view = render(<CanvasApp transport={TEST_TRANSPORT} />);
  send({ type: 'graph', graph });
  send({
    type: 'authored',
    components: graph.components.map((c) => c.id),
    events: graph.events.map((e) => e.id),
  });
  posted.length = 0; // only the clicks below matter
  return view;
}

function send(msg: HostMsg) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

function edits(): Array<{ kind: string; id?: string; nodeKind?: string; io?: string }> {
  return posted
    .filter((m) => m.type === 'edit')
    .map((m) => m.intent as { kind: string; id?: string; nodeKind?: string; io?: string });
}

describe('add I/O pins from the structures view', () => {
  it('the on-node "+ in" overlay adds an input pin inside the composite', () => {
    const { container } = setup();
    const pinButtons = () => {
      const unit = [...container.querySelectorAll('.node.composite')].find((n) =>
        n.textContent?.includes('Accelerator'),
      )!;
      return [...unit.querySelectorAll<HTMLButtonElement>('.composite-add-pins button')];
    };
    const [addIn, addOut] = pinButtons();
    expect(addIn.textContent).toContain('in');
    expect(addOut.textContent).toContain('out');

    act(() => addIn.click());
    expect(edits()).toContainEqual({
      kind: 'addComponent',
      id: 'Unit1.In1',
      nodeKind: 'leaf',
      io: 'in',
    });

    act(() => pinButtons()[1].click());
    expect(edits()).toContainEqual({
      kind: 'addComponent',
      id: 'Unit1.Out1',
      nodeKind: 'leaf',
      io: 'out',
    });
  });

  it('the inspector lists boundary pins and its buttons add pins too', () => {
    const { container } = setup();
    send({ type: 'selection', id: 'Unit1' });

    const inspector = container.querySelector('.inspector')!;
    expect(inspector.textContent).toContain('Boundary pins');
    expect(inspector.textContent).toContain('Request in'); // the existing io child

    const addOut = [...inspector.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Add output'),
    )!;
    act(() => addOut.click());
    expect(edits()).toContainEqual({
      kind: 'addComponent',
      id: 'Unit1.Out1',
      nodeKind: 'leaf',
      io: 'out',
    });
  });

  it('pin ids skip taken names (Unit1.req exists, In1 is free; a second In pin gets In2)', () => {
    const { container } = setup();
    const addInButton = () =>
      [...container.querySelectorAll('.node.composite')]
        .find((n) => n.textContent?.includes('Accelerator'))!
        .querySelector<HTMLButtonElement>('.composite-add-pins button')!;
    act(() => addInButton().click());
    // The webview dedupes against the *posted* graph, which hasn't round-tripped
    // the first add — so re-send a graph that now contains Unit1.In1.
    const model = [
      ...FIXTURE,
      { kind: 'addComponent', id: 'Unit1.In1', nodeKind: 'leaf', io: 'in' } as EditIntent,
    ].reduce(applyIntent, EMPTY_MODEL);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-addpin2-'));
    writeModel(root, model);
    send({ type: 'graph', graph: augmentWithModel(parseProject([root]), model) });
    posted.length = 0;
    act(() => addInButton().click());
    expect(edits()).toContainEqual({
      kind: 'addComponent',
      id: 'Unit1.In2',
      nodeKind: 'leaf',
      io: 'in',
    });
  });
});
