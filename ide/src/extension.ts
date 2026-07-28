// activate(): wires the GraphStore, TreeViews, the single canvas webview, the
// authoring session, run/verify commands, and the SPEC surface (Layer 1).

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { AuthoringModel } from '@iss/contracts/model';
import type { RunConfig } from '@iss/contracts/runConfig';
import type { HostMsg, SailStatus, ViewMsg } from '@iss/contracts/messaging';
import { undeliveredHops } from '@iss/contracts/trace';
import { deriveFabric } from '@iss/contracts/fabric';
import type { Trace } from '@iss/contracts/trace';
import {
  SPEC_TEMPLATES,
  TEMPLATE_RV32I,
  applySpecEdit,
  type SpecDocument,
  type SpecEdit,
} from '@iss/contracts/spec';
import {
  applyIntent,
  augmentWithModel,
  checkedLeaves,
  collectWaves,
  lintSv,
  loadLayout,
  backupSidecarFor,
  openModel,
  loadRunConfig,
  loadSpec,
  saveLayout,
  saveRunConfig,
  saveSpec,
  simulate,
  svFileFor,
  synthesizeTrace,
  verify,
  wavesFileFor,
  writeHarness,
  writeModel,
  type RunDeps,
} from '@iss/host';
import { GraphStore } from './host/graphStore';
import { ComponentsProvider, EventsProvider, LinksProvider } from './host/trees';
import { SpecProvider } from './host/specTree';
import { revealBlock, revealRange } from './host/reveal';

function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration().get<T>(`iss2.${key}`) ?? fallback;
}

function resolveProjectRoot(): string | null {
  const configured = config('projectRoot', '');
  if (configured) return configured;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function resolveEnginePath(context: vscode.ExtensionContext, projectRoot: string): string {
  const configured = config('enginePath', '');
  if (configured) return configured;
  const candidates = [
    path.resolve(context.extensionPath, '..', 'engine'),
    path.resolve(projectRoot, '..', 'engine'),
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'include'))) return c;
  return candidates[0];
}

class CanvasPanel {
  static current: CanvasPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private lastTrace: Trace | null = null;

  static show(context: vscode.ExtensionContext, deps: PanelDeps): CanvasPanel {
    if (CanvasPanel.current) {
      CanvasPanel.current.panel.reveal();
      return CanvasPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'iss2.canvas',
      'ISS Canvas',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
      },
    );
    CanvasPanel.current = new CanvasPanel(panel, context, deps);
    return CanvasPanel.current;
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private deps: PanelDeps,
  ) {
    panel.webview.html = this.html(context);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(
      (msg: ViewMsg) => void this.onMessage(msg),
      null,
      this.disposables,
    );
    this.disposables.push(
      deps.store.onDidChange(() => this.postGraph()),
    );
  }

  post(msg: HostMsg): void {
    void this.panel.webview.postMessage(msg);
  }

  postGraph(): void {
    this.post({
      type: 'graph',
      graph: augmentWithModel(this.deps.store.current, this.deps.model()),
    });
  }

  postAuthored(): void {
    this.post({
      type: 'authored',
      components: this.deps.model().components.map((c) => c.id),
      events: this.deps.model().events.map((e) => e.id),
    });
  }

  sendTrace(trace: Trace): void {
    this.lastTrace = trace;
    this.post({ type: 'trace', trace });
  }
  get trace(): Trace | null {
    return this.lastTrace;
  }

  private async onMessage(msg: ViewMsg): Promise<void> {
    const { deps } = this;
    switch (msg.type) {
      case 'ready':
        this.postGraph();
        this.post({ type: 'layout', layout: loadLayout(deps.projectRoot) });
        this.postAuthored();
        this.post({ type: 'spec', spec: deps.spec() });
        this.post({ type: 'runConfig', config: deps.runConfig() });
        if (this.lastTrace) this.post({ type: 'trace', trace: this.lastTrace });
        break;
      case 'select':
        break; // selection lives in the webview; trees drive selectBlock instead
      case 'reveal': {
        const comp = deps.store.blockById(msg.id);
        if (comp) await revealBlock(comp, deps.projectRoot);
        break;
      }
      case 'revealEvent': {
        const event = deps.store.current.events.find((e) => e.id === msg.id);
        if (event) await revealRange(event.decl);
        break;
      }
      case 'revealFile': {
        const file = path.join(deps.projectRoot, msg.path);
        if (fs.existsSync(file)) {
          const doc = await vscode.workspace.openTextDocument(file);
          await vscode.window.showTextDocument(doc, { preview: false });
        } else {
          this.post({ type: 'editError', message: `${msg.path} does not exist yet — save an edit to generate it` });
        }
        break;
      }
      case 'edit': {
        try {
          deps.applyEdit(msg.intent);
          this.postAuthored();
          this.postGraph(); // composites/labels may change without a parse delta
        } catch (err) {
          this.post({
            type: 'editError',
            message: String(err instanceof Error ? err.message : err),
          });
        }
        break;
      }
      case 'specEdit':
        deps.applySpecEdit(msg.edit);
        this.post({ type: 'spec', spec: deps.spec() });
        break;
      case 'createSpec':
        deps.createSpec(msg.templateId);
        this.post({ type: 'spec', spec: deps.spec() });
        break;
      case 'setRunConfig':
        deps.setRunConfig(msg.config);
        this.post({ type: 'runConfig', config: deps.runConfig() });
        break;
      case 'saveLayout':
        saveLayout(deps.projectRoot, msg.layout);
        break;
      case 'simulate':
        await vscode.commands.executeCommand('iss2.runSimulation');
        break;
      case 'verify':
        await vscode.commands.executeCommand('iss2.verifyAgainstSail');
        break;
    }
  }

  private html(context: vscode.ExtensionContext): string {
    const media = (file: string) =>
      this.panel.webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'media', file)),
      );
    const csp = this.panel.webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp}; img-src ${csp} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('webview.css')}">
<title>ISS Canvas</title>
</head>
<body>
<div id="root"></div>
<script src="${media('webview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    CanvasPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
  }
}

interface PanelDeps {
  store: GraphStore;
  projectRoot: string;
  model: () => AuthoringModel;
  applyEdit: (intent: Parameters<typeof applyIntent>[1]) => void;
  spec: () => SpecDocument | null;
  applySpecEdit: (edit: SpecEdit) => void;
  createSpec: (templateId: string) => void;
  runConfig: () => RunConfig;
  setRunConfig: (config: RunConfig) => void;
}

export function activate(context: vscode.ExtensionContext): void {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) return;
  const enginePath = resolveEnginePath(context, projectRoot);

  const store = new GraphStore(projectRoot);
  context.subscriptions.push(store);

  // ---- authoring session: model sidecar + code emission -------------------
  const opened = openModel(projectRoot);
  let model: AuthoringModel = opened.model;
  if (opened.blocked) void vscode.window.showErrorMessage(opened.blocked);
  else if (opened.migratedFrom !== undefined)
    void vscode.window.showInformationMessage(
      `Design file migrated from schema v${opened.migratedFrom} — the original is kept as ` +
        `${backupSidecarFor(opened.migratedFrom)}.` +
        (opened.notes.length ? ` ${opened.notes.map((n) => n.reason).join('; ')}` : ''),
    );

  const applyEdit = (intent: Parameters<typeof applyIntent>[1]) => {
    // A sidecar we could not read must never be overwritten by an edit.
    if (opened.blocked) {
      void vscode.window.showErrorMessage(opened.blocked);
      return;
    }
    model = applyIntent(model, intent);
    writeModel(projectRoot, model, loadSpec(projectRoot));
    store.reparse();
  };


  // ---- trees ---------------------------------------------------------------
  const components = new ComponentsProvider();
  const links = new LinksProvider();
  const events = new EventsProvider();
  const output = vscode.window.createOutputChannel('ISS');
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('iss2.components', components),
    vscode.window.registerTreeDataProvider('iss2.links', links),
    vscode.window.registerTreeDataProvider('iss2.events', events),
    store.onDidChange((graph) => {
      const augmented = augmentWithModel(graph, model);
      components.update(augmented);
      links.update(augmented);
      events.update(augmented);
    }),
    output,
  );

  // ---- spec surface (Layer 1) -------------------------------------------------
  let sailStatus: SailStatus = {
    available: Boolean(config('sailCommitrecPath', '')),
    ref: config<'sail' | 'stub'>('refModel', 'sail'),
  };
  const specProvider = new SpecProvider(loadSpec(projectRoot), sailStatus);
  const refreshSpec = () => {
    const spec = loadSpec(projectRoot);
    specProvider.update(spec, sailStatus);
    CanvasPanel.current?.post({ type: 'spec', spec });
  };
  context.subscriptions.push(vscode.window.registerTreeDataProvider('iss2.isa', specProvider));
  for (const pattern of ['iss_spec.json', 'iss_isa.json']) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(projectRoot, pattern),
    );
    watcher.onDidChange(refreshSpec);
    watcher.onDidCreate(refreshSpec);
    watcher.onDidDelete(refreshSpec);
    context.subscriptions.push(watcher);
  }

  // Any spec change re-renders the arch header so the generated C++ always
  // reflects the contract.
  const specChanged = (spec: SpecDocument) => {
    writeModel(projectRoot, model, spec);
    store.reparse();
    refreshSpec();
    CanvasPanel.current?.postAuthored();
  };

  const editSpec = (edit: SpecEdit) => {
    const spec = loadSpec(projectRoot) ?? JSON.parse(JSON.stringify(TEMPLATE_RV32I));
    const next = applySpecEdit(spec as SpecDocument, edit);
    saveSpec(projectRoot, next);
    specChanged(next);
  };

  const panelDeps: PanelDeps = {
    store,
    projectRoot,
    model: () => model,
    applyEdit,
    spec: () => loadSpec(projectRoot),
    applySpecEdit: editSpec,
    createSpec: (templateId) => {
      const template = SPEC_TEMPLATES.find((t) => t.id === templateId) ?? SPEC_TEMPLATES[0];
      const spec = JSON.parse(JSON.stringify(template.spec)) as SpecDocument;
      saveSpec(projectRoot, spec);
      specChanged(spec);
    },
    runConfig: () => loadRunConfig(projectRoot),
    setRunConfig: (config) => saveRunConfig(projectRoot, config),
  };

  // Auto-discover xverify when unconfigured (read-only use of a sibling
  // checkout; iss2.xverifyPath always wins).
  const resolveXverify = (): string => {
    const configured = config('xverifyPath', '');
    if (configured) return configured;
    const candidates = [
      path.resolve(projectRoot, '..', 'xverify', 'xverify'),
      path.resolve(projectRoot, '..', '..', 'micro_arch_IDE', 'xverify', 'xverify'),
      path.resolve(projectRoot, '..', 'micro_arch_IDE', 'xverify', 'xverify'),
    ];
    return candidates.find((c) => fs.existsSync(c)) ?? '';
  };

  const runDeps = (): RunDeps => ({
    projectRoot,
    enginePath,
    xverifyPath: resolveXverify(),
    sailCommitrecPath: config('sailCommitrecPath', ''),
    refModel: config<'sail' | 'stub'>('refModel', 'sail'),
    log: (line) => {
      output.appendLine(line);
      CanvasPanel.current?.post({ type: 'runlog', line });
    },
  });

  // ---- commands --------------------------------------------------------------
  const command = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  command('iss2.openCanvas', () => CanvasPanel.show(context, panelDeps));
  command('iss2.reparse', () => store.reparse());
  command('iss2.selectBlock', (id) => {
    CanvasPanel.show(context, panelDeps).post({ type: 'selection', id: String(id) });
  });
  command('iss2.reveal', async (id) => {
    const comp = store.blockById(String(id));
    if (comp) await revealBlock(comp, projectRoot);
  });
  command('iss2.revealEvent', async (id) => {
    const event = store.current.events.find((e) => e.id === String(id));
    if (event) await revealRange(event.decl);
  });
  command('iss2.generateHarness', () => {
    const file = writeHarness(projectRoot, model, loadRunConfig(projectRoot));
    void vscode.window.showInformationMessage(`ISS: harness written to ${file}`);
  });
  // SV twins: which blocks are set to the SV implementation, and their files.
  const svImplFiles = () =>
    model.components
      .filter((c) => c.kind === 'leaf' && c.impl === 'sv')
      .map((c) => path.join('src', svFileFor(c.id)));

  command('iss2.lintSv', async () => {
    const panel = CanvasPanel.show(context, panelDeps);
    const log = (line: string) => {
      output.appendLine(line);
      panel.post({ type: 'runlog', line });
    };
    const all = model.components
      .filter((c) => c.kind === 'leaf')
      .map((c) => path.join('src', svFileFor(c.id)));
    if (all.length === 0) {
      log('no SV twins to lint — add blocks first');
      return;
    }
    await lintSv(projectRoot, all, log);
  });

  command('iss2.runSimulation', async () => {
    const panel = CanvasPanel.show(context, panelDeps);
    panel.post({ type: 'runlog', clear: true, status: { phase: 'building' } });
    const log = (line: string) => {
      output.appendLine(line);
      panel.post({ type: 'runlog', line });
    };
    try {
      // SV co-simulation: lint the chosen twins first (fast, better errors
      // than a raw verilate failure), then verilate + execute them for real.
      const sv = svImplFiles();
      if (sv.length > 0) {
        log(`${sv.length} block(s) set to SV — their Verilated twins will execute. Linting first…`);
        const results = await lintSv(projectRoot, sv, log);
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0)
          panel.post({
            type: 'editError',
            message: `SV lint failed for ${failed.map((f) => f.file).join(', ')} — see console`,
          });
      }
      const svLeaves = model.components
        .filter((c) => c.kind === 'leaf' && c.impl === 'sv')
        .map((c) => ({ id: c.id, svFile: path.join('src', svFileFor(c.id)) }));
      const runConfig = loadRunConfig(projectRoot);
      writeHarness(projectRoot, model, runConfig);
      const checked = [...checkedLeaves(model, runConfig)].sort();
      if (checked.length > 0)
        log(
          `divergence check: ${checked.join(', ')} — each also runs its C++ block in shadow; ` +
            'per-token output mismatches land in PROBLEMS.',
        );
      const derivation = deriveFabric(model);
      // Wires between top-level units are not allowed at all: dataflow there
      // is authored as forwarding rules. Refuse to run while any exist.
      const fabricErrors = derivation.diagnostics.filter((d) => d.severity === 'error');
      if (fabricErrors.length > 0) {
        for (const d of fabricErrors) log(`⛔ ${d.detail}`);
        panel.post({
          type: 'editError',
          message:
            `⛔ ${fabricErrors.length} cross-top wire(s) — dataflow between top-level units ` +
            'is authored as forwarding rules on a ◈ Router, not wires. Delete each listed ' +
            'wire and add a rule on the router instead (see CONSOLE for the list).',
        });
        panel.post({ type: 'runlog', status: { phase: 'error', detail: 'cross-top wires' } });
        return;
      }
      // Rule problems degrade to runtime drop+report — warn, don't block.
      for (const d of derivation.diagnostics.filter((x) => x.severity === 'warning'))
        log(`⚠ ${d.detail}`);
      if (derivation.ruleRoutes.length > 0)
        log(
          `fabric: ${derivation.ruleRoutes.length} rule route(s) — ` +
            derivation.ruleRoutes
              .map(
                (r) =>
                  `${r.router}[${r.message}${r.addrLo || r.addrHi ? ` ${r.addrLo ?? '0x0'}..${r.addrHi ?? 'max'}` : ''}]` +
                  `→${r.path.join('→')}→${r.destLeaf}${r.model ? ` (latency: ${r.model})` : ''}`,
              )
              .join(', '),
        );
      // Augmented graph so trace names resolve against routers too.
      const trace = await simulate(runDeps(), augmentWithModel(store.current, model), svLeaves);
      panel.sendTrace(trace);
      const waves = collectWaves(projectRoot, svLeaves.map((l) => l.id));
      for (const doc of waves)
        log(`waves: ${wavesFileFor(doc.block)} (${doc.signals.length} signals)`);
      panel.post({ type: 'waves', waves });
      const undelivered = undeliveredHops(trace);
      if (undelivered.length > 0)
        panel.post({
          type: 'editError',
          message:
            `⚠ ${undelivered.length} event(s) never delivered — the clock stopped at cycle ` +
            `${trace.ranCycles} but arrivals extend to ${trace.cycles - 1}. Raise cycles in ` +
            `the run config or shorten wire latencies (see PROBLEMS).`,
        });
      panel.post({ type: 'runlog', status: { phase: 'done' } });
    } catch (err) {
      panel.post({
        type: 'runlog',
        line: String(err instanceof Error ? err.message : err),
        status: { phase: 'error', detail: String(err) },
      });
    }
  });
  command('iss2.animateRun', () => {
    const panel = CanvasPanel.show(context, panelDeps);
    panel.sendTrace(panel.trace ?? synthesizeTrace(store.current));
  });
  command('iss2.verifyAgainstSail', async () => {
    const panel = CanvasPanel.show(context, panelDeps);
    panel.post({ type: 'runlog', status: { phase: 'running' } });
    const deps = runDeps();
    const result = await verify(deps, store.current, panel.trace);
    sailStatus = {
      available: result.ok !== null,
      ref: result.ref,
      lastRun: result.ok === null ? undefined : { ok: result.ok, matched: result.matched },
      why: result.ok === null ? 'xverify/Sail not configured — see console' : undefined,
    };
    refreshSpec();
    panel.post({ type: 'sail', status: sailStatus });
    if (result.divergences.length > 0 && panel.trace) {
      panel.sendTrace({ ...panel.trace, divergences: result.divergences });
    }
    panel.post({ type: 'runlog', status: { phase: result.ok === false ? 'error' : 'done' } });
  });
  command('iss2.addInstruction', async () => {
    const mnemonic = await vscode.window.showInputBox({
      prompt: 'Operation mnemonic (e.g. mac)',
      validateInput: (v) => (/^[a-z][a-z0-9._]*$/.test(v) ? null : 'lowercase mnemonic'),
    });
    if (!mnemonic) return;
    const format = await vscode.window.showQuickPick(['R', 'I', 'S', 'B', 'U', 'J', '(none)'], {
      placeHolder: 'Encoding format (RISC-V) or none',
    });
    const summary =
      (await vscode.window.showInputBox({ prompt: 'Summary (e.g. rd = rs1 * rs2 + rd)' })) ?? '';
    editSpec({
      kind: 'addOp',
      op: {
        mnemonic,
        format: format && format !== '(none)' ? format : undefined,
        summary,
        oracle: false,
      },
    });
  });
  command('iss2.addStateElement', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'State element name (e.g. acc)' });
    if (!name) return;
    const bits = Number(
      (await vscode.window.showInputBox({ prompt: 'Width in bits', value: '32' })) ?? '32',
    );
    editSpec({
      kind: 'addState',
      element: { name, label: name, bits: Number.isFinite(bits) ? bits : 32, space: 'reg' },
    });
  });
  command('iss2.regenerateOracle', () => {
    // Honest label (P2.10): folding spec-only operations into the Sail build
    // is engine-owned work; say so instead of silently no-op'ing.
    void vscode.window.showWarningMessage(
      'ISS: Regenerate Oracle is not yet wired — spec-only operations are recorded in ' +
        'iss_spec.json but the Sail oracle build must be regenerated externally ' +
        '(see xverify/reference/sail).',
    );
  });

  store.reparse();
}

export function deactivate(): void {
  // subscriptions dispose everything
}
