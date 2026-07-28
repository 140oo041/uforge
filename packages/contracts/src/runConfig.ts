// Run configuration: what the simulation runs and where it starts.
// Persisted to <project>/iss_run.json; consumed by the harness generator.

export interface SeedSpec {
  /** Full dot-path id of the leaf to seed. */
  block: string;
  /** Event type to inject; null = auto (the block's first consumed event, else generic). */
  event: string | null;
}

export interface RunConfig {
  /** Blocks to seed. Empty = auto: leaves nobody sends to (entryLeaves heuristic). */
  entries: SeedSpec[];
  /** Tokens injected per entry, one per cycle starting at 0. */
  tokens: number;
  /** Default cycle budget (the binary's CLI arg still overrides at runtime). */
  cycles: number;
  /** Record VCD waveforms for SV-impl blocks (build/waves/<id>.vcd). */
  wavesEnabled: boolean;
  /** Master switch: run a C++ shadow for EVERY SV-impl block and report
   *  per-token output mismatches. Off by default; a block's own
   *  checkDivergence flag enables the check for just that block. */
  checkDivergence: boolean;
}

export const DEFAULT_RUN_CONFIG: RunConfig = {
  entries: [],
  tokens: 8,
  cycles: 64,
  wavesEnabled: true,
  checkDivergence: false,
};

/** Tolerant normalization for hand-edited / older iss_run.json files. */
export function normalizeRunConfig(raw: unknown): RunConfig {
  const v = (raw ?? {}) as Partial<RunConfig>;
  const entries = Array.isArray(v.entries)
    ? v.entries
        .filter((e): e is SeedSpec => !!e && typeof (e as SeedSpec).block === 'string')
        .map((e) => ({ block: e.block, event: typeof e.event === 'string' ? e.event : null }))
    : [];
  const num = (n: unknown, fallback: number) =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return {
    entries,
    tokens: num(v.tokens, DEFAULT_RUN_CONFIG.tokens),
    cycles: num(v.cycles, DEFAULT_RUN_CONFIG.cycles),
    wavesEnabled: v.wavesEnabled !== false,
    checkDivergence: v.checkDivergence === true,
  };
}
