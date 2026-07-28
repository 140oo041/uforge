// Trace fixture helpers.
//
// parseTrace REFUSES a trace that carries records but no timebase, because
// reading ticks as cycles is silent: the playhead sits at 0 for the whole run
// and nothing errors. Hand-written fixtures therefore need a units line, and
// pasting it into every test would bury the thing each test is actually about.

/** A unit timebase: one tick per cycle, so fixture numbers read as cycles. */
export const UNIT_TIMEBASE =
  '{"timebase":{"femtosPerTick":1,"reference":0,' +
  '"domains":[{"name":"main","periodTicks":1,"phaseTicks":0,"syncDepth":0}]}}';

/** Prefix JSONL with the unit timebase the reader requires. */
export function withTimebase(jsonl: string): string {
  return `${UNIT_TIMEBASE}\n${jsonl}`;
}
