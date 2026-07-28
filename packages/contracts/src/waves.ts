// Waveform document types — shared between the host (VCD parsing after a
// run) and the webview (WAVES panel rendering). VCD time relates to engine
// cycles via the adapter's dump scheme: time 2c = posedge of cycle c,
// time 2c+1 = negedge (see writer/svadapter.ts).

export interface WaveChange {
  /** VCD timestamp (2*cycle for posedge, 2*cycle+1 for negedge). */
  t: number;
  /** Bit value ('0' | '1' | 'x' | 'z') or a bit string for vectors. */
  v: string;
}

export interface WaveSignal {
  /** VCD identifier code (unique per signal within a document). */
  id: string;
  /** Dot-joined hierarchical name, e.g. "Alpha.ReqEvent_valid". */
  name: string;
  /** Bit width (1 = scalar). */
  width: number;
  /** Value changes in time order. */
  changes: WaveChange[];
}

export interface WaveDoc {
  /** Component id the VCD belongs to, e.g. "Alpha" or "CPU0.IF". */
  block: string;
  /** Raw $timescale text, if present. */
  timescale: string | null;
  /** Largest timestamp seen. */
  maxTime: number;
  signals: WaveSignal[];
}
