// @iss/host — everything a host needs to turn a directory of C++ into a running
// design, and nothing that assumes which host is asking.
//
// The rule this package enforces: no editor API, no window, no IPC. It reads
// and writes real files, spawns real compilers, and parses real traces. The VS
// Code extension and the Electron main process both sit on top of it and differ
// only in how they surface the results.

// Reading the design out of the sources.
export { ProjectParser } from './parser';
export { GraphStore, SOURCE_EXTENSIONS, SOURCE_GLOB, type GraphStoreEvents } from './project/graphStore';
export { resolveBlockSource, type SourceLocation } from './project/source';
export {
  detectEditor,
  openFolderInEditor,
  openInEditor,
  type EditorTarget,
} from './project/editor';

// Writing the design back into them.
export { applyIntent } from './writer/edits';
export { SIDECAR, blockFileFor, checkedLeaves, loadModel, writeHarness, writeModel } from './writer';
export { svFileFor } from './writer/svtwin';
export { SV_ADAPTERS_FILE, svLeavesOf } from './writer/svadapter';

// The architectural spec (layer 1).
export { loadSpec, saveSpec } from './spec';

// Running it, and grading it.
export { simulate, verify, type RunDeps } from './project/run';
export { lintSv } from './project/lint';
export { augmentWithModel } from './project/augment';
export { collectWaves, wavesFileFor } from './project/waves';
export { synthesizeTrace } from './trace/synthesize';
export { parseTrace } from './trace/parse';

// Per-project persisted settings.
export { loadRunConfig, saveRunConfig } from './project/runFile';
export { loadLayout, saveLayout } from './project/layout';
