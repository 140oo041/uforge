// @iss/contracts — the one shared vocabulary.
//
// Three things live here and nothing else: the read-model the parser recovers
// from the sources (graph), the write-model the canvas authors into them
// (model), and the protocol a host speaks to a view (messaging). Everything is
// pure — no Node, no DOM, no host API — so the extension host, the Electron
// main process, the renderer and the test suite all compile against the same
// definitions rather than against each other.
//
// Import the barrel for convenience or a subpath (`@iss/contracts/graph`) when
// you want the narrower surface.

export * from './bits';
export * from './fabric';
export * from './graph';
export * from './messaging';
export * from './model';
export * from './runConfig';
export * from './spec';
export * from './trace';
export * from './waves';
