// @vitest-environment happy-dom
// Three surfaces that let you work on a design without reading its C++:
//
//   In-ports    a leaf's consumed messages, with the senders that reach it,
//               editable through setConsumes rather than by hand-editing a
//               handler signature
//   Messages    the packet vocabulary as a place — add, delete (only when
//               nothing uses it), edit the payload, override the width
//   ⌘C / ⌘V     copy blocks across drill levels, not just "duplicate in place"
//
// All three go through the same EditIntent seam every other canvas edit uses,
// so the assertions here are on the intents that reach the host.

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
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
  { kind: 'addComponent', id: 'Unit1.Stage1', label: 'Stage1' },
  { kind: 'addComponent', id: 'Unit1.Stage2', label: 'Stage2' },
  { kind: 'addEvent', id: 'StepEvent', fields: [{ name: 'pc', type: 'uint32_t' }] },
  // An event nothing uses — the only kind the model lets you delete.
  { kind: 'addEvent', id: 'SpareEvent', fields: [] },
  {
    kind: 'addWire',
    from: 'Unit1.Stage1',
    port: 'out_Stage1_to_Stage2',
    message: 'StepEvent',
    to: 'Unit1.Stage2',
    latency: 1,
  },
  { kind: 'setConsumes', id: 'Unit1.Stage2', consumes: ['StepEvent'] },
];

const posted: Array<{ type: string; intent?: unknown }> = [];
const TRANSPORT = windowMessageTransport((msg) =>
  posted.push(msg as { type: string; intent?: unknown }),
);

function send(msg: HostMsg) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-vocab-'));
  const model = FIXTURE.reduce(applyIntent, EMPTY_MODEL);
  writeModel(root, model);
  const graph = augmentWithModel(parseProject([root]), model);
  const view = render(<CanvasApp transport={TRANSPORT} />);
  send({ type: 'graph', graph });
  send({
    type: 'authored',
    components: graph.components.map((c) => c.id),
    events: graph.events.map((e) => e.id),
  });
  posted.length = 0;
  return view;
}

// One mounted app per test: without this every previously rendered CanvasApp
// stays subscribed to window keydown and answers the same ⌘V.
afterEach(cleanup);

function edits(): Array<Record<string, unknown>> {
  return posted.filter((m) => m.type === 'edit').map((m) => m.intent as Record<string, unknown>);
}

const buttonWith = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(text),
  );

describe('the in-ports card', () => {
  it('lists consumed messages with their width and who sends them', () => {
    const { container } = setup();
    send({ type: 'selection', id: 'Unit1.Stage2' });

    const card = container.querySelector('#inputs, .insp-card')!;
    const inspector = container.querySelector('.inspector')!;
    expect(inspector.textContent).toContain('In-ports');
    expect(inspector.textContent).toContain('StepEvent');
    // 32 bits from the single uint32_t field, shown next to the message.
    expect(inspector.textContent).toContain('32 b');
    // The sender is recovered from the wire, so the panel answers "what can
    // reach this block" without opening the source.
    expect(inspector.textContent).toContain('Unit1.Stage1');
    expect(card).toBeTruthy();
  });

  it('drops a consumed message through setConsumes', () => {
    const { container } = setup();
    send({ type: 'selection', id: 'Unit1.Stage2' });

    const remove = [...container.querySelectorAll<HTMLButtonElement>('.insp-iconbtn')].find((b) =>
      b.getAttribute('aria-label')?.startsWith('stop consuming'),
    )!;
    act(() => remove.click());
    expect(edits()).toContainEqual({ kind: 'setConsumes', id: 'Unit1.Stage2', consumes: [] });
  });

  it('adds one from the picker of messages it does not yet consume', () => {
    const { container } = setup();
    send({ type: 'selection', id: 'Unit1.Stage2' });

    const picker = container.querySelector<HTMLSelectElement>('#insp-inputs select')!;
    // StepEvent is already consumed, so only SpareEvent is on offer.
    const options = [...picker.options].map((o) => o.value).filter(Boolean);
    expect(options).toEqual(['SpareEvent']);

    fireEvent.change(picker, { target: { value: 'SpareEvent' } });
    act(() => buttonWith(picker.parentElement!, '＋')!.click());
    expect(edits()).toContainEqual({
      kind: 'setConsumes',
      id: 'Unit1.Stage2',
      consumes: ['StepEvent', 'SpareEvent'],
    });
  });
});

describe('the messages view', () => {
  function openMessages(container: HTMLElement) {
    act(() => buttonWith(container.querySelector('.tab-bar')!, 'Messages')!.click());
    return container.querySelector('.events-view')!;
  }

  it('lists every message with its derived width', () => {
    const { container } = setup();
    const view = openMessages(container);
    expect(view.textContent).toContain('StepEvent');
    expect(view.textContent).toContain('SpareEvent');
    // StepEvent carries a uint32_t; SpareEvent carries nothing and is charged
    // the default word rather than nothing at all.
    const widths = [...view.querySelectorAll('.ev-bits')].map((n) => n.textContent);
    expect(widths).toEqual(['32 b', '32 b']);
  });

  it('adds a message', () => {
    const { container } = setup();
    const view = openMessages(container);
    const input = view.querySelector<HTMLInputElement>('.ev-new input')!;
    fireEvent.change(input, { target: { value: 'FillEvent' } });
    act(() => buttonWith(view.querySelector('.ev-new')!, '＋')!.click());
    expect(edits()).toContainEqual({ kind: 'addEvent', id: 'FillEvent', fields: [] });
  });

  it('refuses a name that collides or is not an identifier', () => {
    const { container } = setup();
    const view = openMessages(container);
    const input = view.querySelector<HTMLInputElement>('.ev-new input')!;
    const add = () => buttonWith(view.querySelector('.ev-new')!, '＋')!;
    const type = (value: string) => fireEvent.change(input, { target: { value } });

    type('StepEvent'); // already exists
    expect(add().disabled).toBe(true);
    type('Unit1'); // collides with a component
    expect(add().disabled).toBe(true);
    type('2Fast'); // not a C++ identifier
    expect(add().disabled).toBe(true);
    type('FillEvent');
    expect(add().disabled).toBe(false);
  });

  it('only offers delete for a message nothing uses', () => {
    const { container } = setup();
    const view = openMessages(container);
    const rows = [...view.querySelectorAll('.ev-row')];
    const trash = (row: Element) => row.querySelector<HTMLButtonElement>('.ev-icon.danger')!;

    const step = rows.find((r) => r.textContent?.includes('StepEvent'))!;
    expect(trash(step).disabled).toBe(true);
    expect(trash(step).title).toContain('in use by');

    const spare = rows.find((r) => r.textContent?.includes('SpareEvent'))!;
    expect(trash(spare).disabled).toBe(false);
    act(() => trash(spare).click());
    expect(edits()).toContainEqual({ kind: 'removeEvent', id: 'SpareEvent' });
  });

  it('edits the payload and overrides the width', () => {
    const { container } = setup();
    const view = openMessages(container);
    const step = [...view.querySelectorAll('.ev-row')].find((r) =>
      r.textContent?.includes('StepEvent'),
    )!;
    act(() => step.querySelector<HTMLButtonElement>('.ev-twist')!.click());

    const [name, type] = [...step.querySelectorAll<HTMLInputElement>('.ev-detail .ev-add input')];
    fireEvent.change(name, { target: { value: 'tag' } });
    fireEvent.change(type, { target: { value: 'uint16_t' } });
    act(() => buttonWith(step.querySelector('.ev-detail .ev-add')!, '＋')!.click());
    expect(edits()).toContainEqual({
      kind: 'editEventFields',
      id: 'StepEvent',
      fields: [
        { name: 'pc', type: 'uint32_t' },
        { name: 'tag', type: 'uint16_t' },
      ],
    });

    const width = step.querySelector<HTMLInputElement>('.ev-bitsin')!;
    fireEvent.change(width, { target: { value: '512' } });
    fireEvent.blur(width);
    expect(edits()).toContainEqual({ kind: 'setEventBits', id: 'StepEvent', bits: 512 });
  });
});

describe('copy and paste', () => {
  const key = (k: string) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true }));
    });

  it('pastes a copied block into the level you are looking at', () => {
    const { container } = setup();
    send({ type: 'selection', id: 'Unit1.Stage1' });
    key('c');
    key('v');
    // Pasted beside the original, under the same parent, with a free id.
    expect(edits()).toContainEqual({
      kind: 'duplicateComponent',
      id: 'Unit1.Stage1',
      newId: 'Unit1.Stage3',
    });
    expect(container).toBeTruthy();
  });

  it('pastes into the level you drilled to, not the one you copied from', () => {
    const { container } = setup();
    // Selecting a nested block drills the canvas into its composite.
    send({ type: 'selection', id: 'Unit1.Stage1' });
    key('c');

    // Walk back out to the root and paste there: the copy lands at the top
    // level with a fresh top-level id. This is what separates paste from the
    // inspector's Duplicate, which can only copy in place.
    act(() => container.querySelector<HTMLButtonElement>('.crumb')!.click());
    key('v');

    expect(edits()).toContainEqual({
      kind: 'duplicateComponent',
      id: 'Unit1.Stage1',
      newId: 'Stage1',
    });
  });

  it('refuses to paste a composite inside itself', () => {
    const { container } = setup();
    send({ type: 'selection', id: 'Unit1' });
    key('c');
    // Drill into the copied composite, then try to paste it into its own body.
    act(() => {
      const unit = [...container.querySelectorAll('.node.composite')].find((n) =>
        (n.textContent ?? '').includes('Accelerator'),
      )!;
      unit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    key('v');
    expect(edits().filter((e) => e.kind === 'duplicateComponent')).toHaveLength(0);
  });

  it('does nothing when the clipboard is empty', () => {
    setup();
    key('v');
    expect(edits()).toHaveLength(0);
  });
});
