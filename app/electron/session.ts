// One open project, and everything the view can ask of it.
//
// This is the extension's CanvasPanel and its run/verify commands, ported off
// the VS Code API. The protocol is unchanged — the same ViewMsg arrive and the
// same HostMsg go back — which is why the canvas cannot tell the difference.
//
// Where the extension leaned on VS Code, this leans on @iss/host: the graph
// store instead of a workspace watcher, chokidar-free fs.watch instead of a
// FileSystemWatcher, and a `post` callback instead of `webview.postMessage`.

import * as fs from 'fs';
import * as path from 'path';

import { deriveFabric } from '@iss/contracts/fabric';
import type { HostMsg, SailStatus, ViewMsg } from '@iss/contracts/messaging';
import { EMPTY_MODEL, type AuthoringModel, type EditIntent } from '@iss/contracts/model';
import type { RunConfig } from '@iss/contracts/runConfig';
import {
  SPEC_TEMPLATES,
  TEMPLATE_RV32I,
  applySpecEdit,
  type SpecDocument,
} from '@iss/contracts/spec';
import { undeliveredHops, type Trace } from '@iss/contracts/trace';
import {
  GraphStore,
  applyIntent,
  augmentWithModel,
  checkedLeaves,
  collectWaves,
  lintSv,
  loadLayout,
  loadModel,
  loadRunConfig,
  loadSpec,
  resolveBlockSource,
  saveLayout,
  saveRunConfig,
  saveSpec,
  simulate,
  svFileFor,
  verify,
  wavesFileFor,
  writeHarness,
  writeModel,
  type RunDeps,
  type SourceLocation,
} from '@iss/host';

import { ProjectWatcher } from './watcher';

export interface SessionOptions {
  projectRoot: string;
  /** Where the engine's include/ and build/ live. */
  enginePath: string;
  xverifyPath: string;
  sailCommitrecPath: string;
  refModel: 'sail' | 'stub';
  /** Deliver one message to the view. */
  post(msg: HostMsg): void;
  /** Open a source file in whatever the user considers their editor. */
  openSource(at: SourceLocation): void;
}

export class Session {
  readonly projectRoot: string;
  private store: GraphStore;
  private watcher: ProjectWatcher;
  private model: AuthoringModel;
  private lastTrace: Trace | null = null;
  private sail: SailStatus;
  private unsubscribe: () => void;
  /** One run at a time — a second ▶ while building must not start a second make. */
  private running = false;

  constructor(private opts: SessionOptions) {
    this.projectRoot = opts.projectRoot;
    this.model = loadModel(opts.projectRoot) ?? EMPTY_MODEL;
    this.sail = { available: Boolean(opts.sailCommitrecPath), ref: opts.refModel };

    this.store = new GraphStore(opts.projectRoot);
    this.unsubscribe = this.store.subscribe({
      onGraph: () => this.postGraph(),
      onParseError: (message) => this.post({ type: 'editError', message }),
    });

    this.watcher = new ProjectWatcher(opts.projectRoot, {
      onSourceChange: (file) => this.store.invalidate(file),
      onSpecChange: () => this.post({ type: 'spec', spec: loadSpec(this.projectRoot) }),
    });

    this.store.reparse();
  }

  private post(msg: HostMsg): void {
    this.opts.post(msg);
  }

  private log = (line: string): void => {
    this.post({ type: 'runlog', line });
  };

  private postGraph(): void {
    this.post({ type: 'graph', graph: augmentWithModel(this.store.current, this.model) });
  }

  private postAuthored(): void {
    this.post({
      type: 'authored',
      components: this.model.components.map((c) => c.id),
      events: this.model.events.map((e) => e.id),
    });
  }

  private applyEdit(intent: EditIntent): void {
    this.model = applyIntent(this.model, intent);
    writeModel(this.projectRoot, this.model, loadSpec(this.projectRoot));
    this.store.reparse();
  }

  /** A spec change re-renders the generated C++ so the code matches the contract. */
  private specChanged(spec: SpecDocument): void {
    writeModel(this.projectRoot, this.model, spec);
    this.store.reparse();
    this.post({ type: 'spec', spec });
    this.postAuthored();
  }

  private runDeps(): RunDeps {
    return {
      projectRoot: this.projectRoot,
      enginePath: this.opts.enginePath,
      xverifyPath: this.opts.xverifyPath,
      sailCommitrecPath: this.opts.sailCommitrecPath,
      refModel: this.opts.refModel,
      log: this.log,
    };
  }

  private svImplFiles(): string[] {
    return this.model.components
      .filter((c) => c.kind === 'leaf' && c.impl === 'sv')
      .map((c) => path.join('src', svFileFor(c.id)));
  }

  // ---- the protocol ---------------------------------------------------------

  async handle(msg: ViewMsg): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // Layout BEFORE graph: the graph handler auto-places anything it has no
        // position for, so the saved positions have to be in hand first or every
        // node is briefly placed twice and the file is fighting the heuristic.
        this.post({ type: 'layout', layout: loadLayout(this.projectRoot) });
        this.postGraph();
        this.postAuthored();
        this.post({ type: 'spec', spec: loadSpec(this.projectRoot) });
        this.post({ type: 'runConfig', config: loadRunConfig(this.projectRoot) });
        this.post({ type: 'sail', status: this.sail });
        if (this.lastTrace) this.post({ type: 'trace', trace: this.lastTrace });
        break;

      case 'select':
        break; // selection lives in the view

      case 'reveal': {
        const comp = this.store.blockById(msg.id);
        const at = comp ? resolveBlockSource(comp, this.projectRoot) : null;
        if (at) this.opts.openSource(at);
        else this.post({ type: 'editError', message: `no source on disk for ${msg.id} yet` });
        break;
      }

      case 'revealEvent': {
        const event = this.store.current.events.find((e) => e.id === msg.id);
        if (event) this.opts.openSource({ file: event.decl.file, line: event.decl.line });
        break;
      }

      case 'revealFile': {
        const file = path.join(this.projectRoot, msg.path);
        if (fs.existsSync(file)) this.opts.openSource({ file, line: 1 });
        else
          this.post({
            type: 'editError',
            message: `${msg.path} does not exist yet — save an edit to generate it`,
          });
        break;
      }

      case 'edit':
        try {
          this.applyEdit(msg.intent);
          this.postAuthored();
          this.postGraph(); // composites/labels can change with no parse delta
        } catch (err) {
          this.post({
            type: 'editError',
            message: String(err instanceof Error ? err.message : err),
          });
        }
        break;

      case 'specEdit': {
        const current = loadSpec(this.projectRoot) ?? (JSON.parse(JSON.stringify(TEMPLATE_RV32I)) as SpecDocument);
        const next = applySpecEdit(current, msg.edit);
        saveSpec(this.projectRoot, next);
        this.specChanged(next);
        break;
      }

      case 'createSpec': {
        const template = SPEC_TEMPLATES.find((t) => t.id === msg.templateId) ?? SPEC_TEMPLATES[0];
        const spec = JSON.parse(JSON.stringify(template.spec)) as SpecDocument;
        saveSpec(this.projectRoot, spec);
        this.specChanged(spec);
        break;
      }

      case 'setRunConfig':
        saveRunConfig(this.projectRoot, msg.config);
        this.post({ type: 'runConfig', config: loadRunConfig(this.projectRoot) });
        break;

      case 'saveLayout':
        saveLayout(this.projectRoot, msg.layout);
        break;

      case 'simulate':
        await this.simulate();
        break;

      case 'verify':
        await this.verify();
        break;
    }
  }

  // ---- run ------------------------------------------------------------------

  /**
   * Compile and run the design on the engine. Mirrors iss2.runSimulation
   * exactly, including the hard refusal on cross-top wires — a design that
   * cannot be routed must not appear to run.
   */
  async simulate(): Promise<void> {
    if (this.running) {
      this.post({ type: 'editError', message: 'a run is already in progress' });
      return;
    }
    this.running = true;
    this.post({ type: 'runlog', clear: true, status: { phase: 'building' } });
    try {
      const sv = this.svImplFiles();
      if (sv.length > 0) {
        this.log(
          `${sv.length} block(s) set to SV — their Verilated twins will execute. Linting first…`,
        );
        const results = await lintSv(this.projectRoot, sv, this.log);
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0)
          this.post({
            type: 'editError',
            message: `SV lint failed for ${failed.map((f) => f.file).join(', ')} — see CONSOLE`,
          });
      }

      const svLeaves = this.model.components
        .filter((c) => c.kind === 'leaf' && c.impl === 'sv')
        .map((c) => ({ id: c.id, svFile: path.join('src', svFileFor(c.id)) }));

      const runConfig: RunConfig = loadRunConfig(this.projectRoot);
      writeHarness(this.projectRoot, this.model, runConfig);

      const checked = [...checkedLeaves(this.model, runConfig)].sort();
      if (checked.length > 0)
        this.log(
          `divergence check: ${checked.join(', ')} — each also runs its C++ block in shadow; ` +
            'per-token output mismatches land in PROBLEMS.',
        );

      const derivation = deriveFabric(this.model);
      const fabricErrors = derivation.diagnostics.filter((d) => d.severity === 'error');
      if (fabricErrors.length > 0) {
        for (const d of fabricErrors) this.log(`⛔ ${d.detail}`);
        this.post({
          type: 'editError',
          message:
            `⛔ ${fabricErrors.length} cross-top wire(s) — dataflow between top-level units ` +
            'is authored as forwarding rules on a ◈ Router, not wires. Delete each listed ' +
            'wire and add a rule on the router instead (see CONSOLE for the list).',
        });
        this.post({ type: 'runlog', status: { phase: 'error', detail: 'cross-top wires' } });
        return;
      }

      for (const d of derivation.diagnostics.filter((x) => x.severity === 'warning'))
        this.log(`⚠ ${d.detail}`);

      this.post({ type: 'runlog', status: { phase: 'running' } });
      const trace = await simulate(
        this.runDeps(),
        augmentWithModel(this.store.current, this.model),
        svLeaves,
      );
      this.lastTrace = trace;
      this.post({ type: 'trace', trace });

      const waves = collectWaves(this.projectRoot, svLeaves.map((l) => l.id));
      for (const doc of waves)
        this.log(`waves: ${wavesFileFor(doc.block)} (${doc.signals.length} signals)`);
      this.post({ type: 'waves', waves });

      const undelivered = undeliveredHops(trace);
      if (undelivered.length > 0)
        this.post({
          type: 'editError',
          message:
            `⚠ ${undelivered.length} event(s) never delivered — the clock stopped at cycle ` +
            `${trace.ranCycles} but arrivals extend to ${trace.cycles - 1}. Raise cycles in ` +
            'the run config or shorten wire latencies (see PROBLEMS).',
        });

      this.post({ type: 'runlog', status: { phase: 'done' } });
    } catch (err) {
      // A build failure is the quietest event in the extension; here it is
      // loud on purpose — a console line, a phase, AND a toast.
      const detail = String(err instanceof Error ? err.message : err);
      this.log(detail);
      this.post({ type: 'runlog', status: { phase: 'error', detail } });
      this.post({ type: 'editError', message: `Build failed — ${firstLine(detail)}` });
    } finally {
      this.running = false;
    }
  }

  async verify(): Promise<void> {
    this.post({ type: 'runlog', status: { phase: 'running' } });
    try {
      const result = await verify(this.runDeps(), this.store.current, this.lastTrace);
      this.sail = {
        available: result.ok !== null,
        ref: result.ref,
        lastRun: result.ok === null ? undefined : { ok: result.ok, matched: result.matched },
        why: result.ok === null ? 'xverify/Sail not configured — see CONSOLE' : undefined,
      };
      this.post({ type: 'sail', status: this.sail });
      if (result.divergences.length > 0 && this.lastTrace) {
        this.lastTrace = { ...this.lastTrace, divergences: result.divergences };
        this.post({ type: 'trace', trace: this.lastTrace });
      }
      this.post({ type: 'runlog', status: { phase: 'done' } });
    } catch (err) {
      const detail = String(err instanceof Error ? err.message : err);
      this.log(detail);
      this.post({ type: 'runlog', status: { phase: 'error', detail } });
      this.post({ type: 'editError', message: `Verify failed — ${firstLine(detail)}` });
    }
  }

  /** Re-send everything: used when a window reloads onto a live session. */
  refresh(): void {
    void this.handle({ type: 'ready' });
  }

  dispose(): void {
    this.unsubscribe();
    this.watcher.dispose();
    this.store.dispose();
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
