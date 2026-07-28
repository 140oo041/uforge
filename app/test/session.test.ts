// The desktop host, without a desktop.
//
// Session is deliberately free of any Electron import — it takes a `post`
// callback and an `openSource` callback and does everything else through
// @iss/host. That makes the app's real behaviour testable at full fidelity in
// plain Node: author a design, hand the Session the same ViewMsg the canvas
// sends, and assert on the HostMsg that come back.
//
// This is the app's equivalent of the extension's P0 acceptance case: a design
// authored through the protocol parses back with the links it was given.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HostMsg } from '@iss/contracts/messaging';
import { EMPTY_MODEL, type EditIntent } from '@iss/contracts/model';
import { applyIntent, writeModel } from '@iss/host';

import { Session } from '../electron/session';

/** A minimal but legal design: one composite with two wired leaves inside it. */
const FIXTURE: EditIntent[] = [
  { kind: 'addComponent', id: 'CPU0', label: 'Core 0', nodeKind: 'composite' },
  { kind: 'addComponent', id: 'CPU0.IF', label: 'Fetch' },
  { kind: 'addComponent', id: 'CPU0.DE', label: 'Decode' },
  { kind: 'addEvent', id: 'FetchEvent', fields: [{ name: 'pc', type: 'uint32_t' }] },
  {
    kind: 'addWire',
    from: 'CPU0.IF',
    port: 'out',
    message: 'FetchEvent',
    to: 'CPU0.DE',
    latency: 1,
  },
];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss-app-'));
  writeModel(root, FIXTURE.reduce(applyIntent, EMPTY_MODEL));
  return root;
}

function session(root: string) {
  const posted: HostMsg[] = [];
  const opened: string[] = [];
  const s = new Session({
    projectRoot: root,
    enginePath: path.resolve(__dirname, '..', '..', 'engine'),
    xverifyPath: '',
    sailCommitrecPath: '',
    refModel: 'stub',
    post: (msg) => posted.push(msg),
    openSource: (at) => opened.push(at.file),
  });
  return { s, posted, opened };
}

function firstOf<T extends HostMsg['type']>(
  posted: HostMsg[],
  type: T,
): Extract<HostMsg, { type: T }> | undefined {
  return posted.find((m) => m.type === type) as Extract<HostMsg, { type: T }> | undefined;
}

describe('desktop session', () => {
  it('answers ready with the parsed graph, layout, spec and run config', async () => {
    const root = project();
    const { s, posted } = session(root);
    try {
      posted.length = 0;
      await s.handle({ type: 'ready' });

      // Every message the canvas waits for on mount.
      for (const type of ['graph', 'layout', 'authored', 'spec', 'runConfig', 'sail'] as const)
        expect(firstOf(posted, type), `missing ${type}`).toBeDefined();

      const graph = firstOf(posted, 'graph')!.graph;
      expect(graph.components.map((c) => c.id).sort()).toEqual(['CPU0', 'CPU0.DE', 'CPU0.IF']);

      // The wire the fixture authored comes back off disk as a real link.
      expect(graph.links).toHaveLength(1);
      expect(graph.links[0]).toMatchObject({
        from: 'CPU0.IF',
        to: 'CPU0.DE',
        message: 'FetchEvent',
      });
      expect(graph.links[0].status).toBe('wired');
    } finally {
      s.dispose();
    }
  });

  it('writes a structural edit straight into the C++ and reparses it', async () => {
    const root = project();
    const { s, posted } = session(root);
    try {
      posted.length = 0;
      await s.handle({
        type: 'edit',
        intent: { kind: 'addComponent', id: 'CPU0.EX', label: 'Execute' },
      });

      // The file exists on disk — the canvas edit *is* the source edit.
      expect(fs.existsSync(path.join(root, 'src', 'CPU0', 'EX.cpp'))).toBe(true);

      const graph = firstOf(posted, 'graph')!.graph;
      expect(graph.components.map((c) => c.id)).toContain('CPU0.EX');

      // And it is reported as authored, so the canvas lets it be edited.
      expect(firstOf(posted, 'authored')!.components).toContain('CPU0.EX');
    } finally {
      s.dispose();
    }
  });

  it('reports an unwritable edit as an editError instead of throwing', async () => {
    const root = project();
    const { s, posted } = session(root);
    try {
      posted.length = 0;
      // Renaming something that does not exist is a model-level error.
      await s.handle({
        type: 'edit',
        intent: { kind: 'renameComponent', id: 'NoSuchBlock', label: 'x' },
      });
      expect(firstOf(posted, 'editError')).toBeDefined();
    } finally {
      s.dispose();
    }
  });

  it('persists layout and run config to the project directory', async () => {
    const root = project();
    const { s } = session(root);
    try {
      await s.handle({ type: 'saveLayout', layout: { 'CPU0.IF': { x: 64, y: 32 } } });
      expect(JSON.parse(fs.readFileSync(path.join(root, 'iss_layout.json'), 'utf8'))).toMatchObject(
        { 'CPU0.IF': { x: 64, y: 32 } },
      );

      await s.handle({
        type: 'setRunConfig',
        config: {
          entries: [{ block: 'CPU0.IF', event: 'FetchEvent' }],
          tokens: 4,
          cycles: 64,
          wavesEnabled: false,
          checkDivergence: false,
        },
      });
      // Round-trips through normalizeRunConfig, so the seed survives verbatim.
      expect(JSON.parse(fs.readFileSync(path.join(root, 'iss_run.json'), 'utf8'))).toMatchObject({
        entries: [{ block: 'CPU0.IF', event: 'FetchEvent' }],
        tokens: 4,
      });
    } finally {
      s.dispose();
    }
  });

  it('resolves a block to its real source file when the view asks to reveal it', async () => {
    const root = project();
    const { s, opened } = session(root);
    try {
      await s.handle({ type: 'reveal', id: 'CPU0.IF' });
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain(`IF.cpp`);
      expect(fs.existsSync(opened[0])).toBe(true);
    } finally {
      s.dispose();
    }
  });
});

describe('layout persistence', () => {
  it('sends the saved layout before the graph, so auto-placement cannot win', async () => {
    const root = project();
    // A position the user "dragged" to and which must survive reopening.
    fs.writeFileSync(
      path.join(root, 'iss_layout.json'),
      JSON.stringify({ 'CPU0.IF': { x: 512, y: 344 } }),
    );

    const { s, posted } = session(root);
    try {
      posted.length = 0;
      await s.handle({ type: 'ready' });

      const types = posted.map((m) => m.type);
      // Order is the fix: the graph handler auto-places anything it has no
      // position for, so the file has to arrive first.
      expect(types.indexOf('layout')).toBeLessThan(types.indexOf('graph'));

      const layout = firstOf(posted, 'layout')!.layout;
      expect(layout['CPU0.IF']).toEqual({ x: 512, y: 344 });
    } finally {
      s.dispose();
    }
  });
});
