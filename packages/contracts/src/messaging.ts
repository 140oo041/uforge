// Host ⇄ webview protocol. ONE webview consumes all of HostMsg and may emit
// all of ViewMsg — v1's fatal seam (a shipped webview that ignored the graph
// and never sent edits) is structurally impossible here: the canvas renders
// Graph, and every structural change goes through an EditIntent.

import type { EditIntent } from './model';
import type { Graph } from './graph';
import type { RunConfig } from './runConfig';
import type { SpecDocument, SpecEdit } from './spec';
import type { Trace } from './trace';
import type { WaveDoc } from './waves';

export interface NodeLayout {
  x: number;
  y: number;
}

export type LayoutMap = Record<string, NodeLayout>;

export interface RunStatus {
  phase: 'idle' | 'building' | 'running' | 'done' | 'error';
  detail?: string;
}

export interface SailStatus {
  available: boolean;
  ref: 'sail' | 'stub';
  why?: string;
  lastRun?: { ok: boolean; matched: number };
}

export type HostMsg =
  | { type: 'graph'; graph: Graph }
  | { type: 'layout'; layout: LayoutMap }
  | { type: 'selection'; id: string | null }
  | { type: 'authored'; components: string[]; events: string[] }
  | { type: 'editError'; message: string }
  | { type: 'trace'; trace: Trace }
  | { type: 'runlog'; line?: string; clear?: boolean; status?: RunStatus }
  | { type: 'sail'; status: SailStatus }
  | { type: 'spec'; spec: SpecDocument | null }
  | { type: 'runConfig'; config: RunConfig }
  | { type: 'waves'; waves: WaveDoc[] };

export type ViewMsg =
  | { type: 'ready' }
  | { type: 'select'; id: string | null }
  | { type: 'reveal'; id: string }
  | { type: 'revealEvent'; id: string }
  | { type: 'revealFile'; path: string }
  | { type: 'edit'; intent: EditIntent }
  | { type: 'specEdit'; edit: SpecEdit }
  | { type: 'createSpec'; templateId: string }
  | { type: 'saveLayout'; layout: LayoutMap }
  | { type: 'setRunConfig'; config: RunConfig }
  | { type: 'simulate' }
  | { type: 'verify' };
