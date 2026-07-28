# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: SoC architects on chip teams**, doing pre-RTL exploration — partitioning
the system, sizing and shaping the interconnect, checking traffic patterns,
contention and stalls before anyone commits to RTL. They already live in VS Code,
read and write C++ and SystemVerilog, and are working against a spec deadline.
They arrive with a design question ("does this fabric hold up under this traffic?")
and need an answer they can defend.

**Secondary: students learning architecture**, building a CPU or SoC in order to
understand one. The learning path must stay viable — legible structure, visible
failure, drill-down from system to block internals — but never at the cost of the
expert's density. When the two conflict, the architect wins.

## Product Purpose

A VS Code extension for designing an SoC — and the microarchitecture inside it —
as a graph of connected blocks whose real, cycle-accurate C++ (or Verilated
SystemVerilog) source is the design itself. It compiles and runs that design on
its own engine, then projects the actual per-hop, per-token trace, queue depths,
contention and divergences back onto the canvas.

Success is an architect answering a real structural question — where the fabric
saturates, which unit stalls, whether the SV twin matches the C++ model — from a
run that actually happened, without leaving the editor and without maintaining a
diagram that drifts from the code.

## Positioning

Three properties that only hold together, and that a neighboring tool could not
truthfully copy as a set:

1. **Code is the single source of truth.** The canvas is a structured editor over
   real, hand-editable source that compiles. There is no model-to-code export step
   and therefore no drift; hand-written code outside the marker regions is
   byte-preserved, hand-authored blocks are protected from canvas edits, and a
   drawn wire becomes `configureOut` in the `.cpp` immediately. Architecture
   diagrams elsewhere are drawings of a design; here they *are* the design.
2. **It runs for real, and shows where it broke.** A real cycle-accurate engine,
   real Verilator co-simulation of the SV twins, a real per-hop trace — animated on
   the canvas, graded against a reference model, with divergences and contention
   landing on the block that caused them. Nothing is hidden: unresolved links
   render red, stubs dangle visibly with their reason, unwired fabric blocks Run.
3. **Both altitudes in one tool.** SoC-level rule-based interconnect, traffic
   generation and metrics above; cycle-accurate block internals and ISA-level
   verification below; drill-down between them through composite blocks. These are
   normally two separate tool categories.

## Operating Context

- The user works inside VS Code: canvas webview alongside native editor columns,
  activity-bar trees (Blocks / Wires / Messages / ISA), PROBLEMS, and a bottom
  panel (TRACE transport, PIPELINE grid, WAVES, METRICS, console).
- A design is an on-disk project, not a database: one `.cpp` per leaf block,
  shared `inc/iss_events.h`, generated harness, `iss_authored.model.json`,
  `iss_layout.json`, `iss_spec.json`, a Makefile against `engine/`.
- The loop is edit → parse (on keystroke, debounced, unsaved text as overlay) →
  Run/Verify → read trace and metrics on the canvas → edit again.
- Structure is authored two ways by altitude: point-to-point wires *inside* a
  composite; ordered forwarding rules on routers (message type + inclusive address
  range → destination top) *between* top-level units. Cross-top wires are design
  errors, not shortcuts.
- Drilling down means opening real source: double-clicking a block opens its
  `.cpp`; clicking a message name opens its event class declaration.

## Capabilities and Constraints

**Confirmed capabilities**

- Figma-style canvas: hierarchical composites (namespace + directory, dot-path
  ids), duplicate-subtree for instant multicore, layered auto-layout, per-port
  wire slots, select/move/pan/zoom/undo/redo, palette drag-in, port-dot wire
  drawing with a connect popover that writes the C++ on confirm.
- Bidirectional parse/write: generated marker regions regenerate; everything
  outside them is preserved byte-for-byte. Hand-written members and blocks parse
  back read-only.
- Own C++17 engine: advancing clock, map-based calendar, token minting and
  inheritance across hops, hop/divergence sinks writing the JSONL trace contract,
  two-phase settle→tick clocking, name-based Registry wiring.
- Interconnect: routers as real components with real source; arbitration
  (fifo / round-robin / priority / weighted-DRR keyed on `Event::origin`),
  bandwidth caps, bounded queues that stall or drop, one packet per output port
  per cycle so contention serializes visibly, hand-written per-packet latency
  models picked up by the parser.
- Traffic generators as a sidecar role, with address ranges.
- SV co-simulation: per-leaf SystemVerilog twins, `verilator --cc` cached by
  mtime, generated adapters bridging twins into the engine, C++ and SV blocks
  mixed in one binary; opt-in per-token SV↔C++ divergence checking via a shadow
  C++ instance; per-block VCD waveforms sharing the playhead with the trace
  transport.
- Layer-1 SPEC (`iss_spec.json`): a general architectural contract — named state
  with commit-record spaces, an operation vocabulary, templates for RISC-V RV32I /
  GPU compute core / blank. Operations the oracle actually grades carry ✓oracle;
  the rest are honestly marked spec-only.
- Verification: `xverify --json` run/divergence/result events consumed as-is;
  Sail reference model with an honest visible fallback to stub.
- Metrics: qdepth / flow / stall JSONL records, canvas heat overlay, METRICS tab.

**Constraints and terminology**

- Addresses are canonical `0x`-hex **strings** host-side, compared as BigInt —
  never JavaScript numbers.
- Exactly one webview. Every structural change leaves it as an `EditIntent`; the
  webview never becomes a text editor.
- Blocks are one `.cpp` each, inline class, no `.h`. Events live in the shared
  header.
- Flat designs (two wired top-level leaves) are illegal — nest under a composite.
- Deliberately out of scope: compiler backend, VS Code fork, webview text editor.
  Yosys/OpenSTA metric surfaces are not ported; the graph/trace contracts leave
  room for them as block badges.

**Explicitly undecided**

- **Surface boundary is open.** Whether this stays a VS Code extension, grows a
  standalone web target, or becomes its own application is not decided. Future
  work must not assume an answer in either direction.
- **Naming is provisional.** "ISS", "iss2", and "Microarchitecture IDE" are all
  working titles, inherited from the pre-repositioning identity. No naming
  commitment exists; a future identity may replace any of them.
- **Software-driven simulation is deferred by choice** — a real ISS core, Spike,
  or QEMU adapter driving traffic instead of synthetic generators. Known as the
  natural next capability; not scheduled.

## Evidence on Hand

- `sample/` — a 6-block design project generated by the writer itself, buildable
  and runnable standalone (`make && ./build/design 64` → real `iss_trace.jsonl`).
- `robot_soc/` — an SoC demo exercising rule-based address splitting (a traffic
  generator over `[0x0, 0x1fff]`; router rules splitting `≤0xfff` and `≥0x1000` to
  different memories), with SV twins and a recorded trace.
- Real test suites: 8/8 engine tests, 19/19 headless IDE tests including the P0
  acceptance case (12 drawn wires → 12 links, 0 stubs), a DOM smoke test on the
  webview seam, and `test/svcosim.test.ts` proving SV execution with a twin whose
  behavior deliberately differs from its C++ block.
- `inspector-mockups.html` — a prior four-direction visual exploration of the
  inspector panel. Evidence of past design thinking, not a committed direction.
- `README.md` — the fullest existing account of the product, including the v1→v2
  handover table.

**Absences future work must not fabricate:** there are no users, customers,
testimonials, case studies, press, benchmarks, pricing, licensing, or deployment
claims. Nothing has shipped publicly. Do not invent adoption, performance numbers,
or a company.

## Product Principles

1. **Never hide a failure.** Unresolved links are red, stubs dangle with their
   reason, an unroutable wire badges `⛔ needs router` and blocks Run, a
   not-yet-wired action says so rather than silently no-op'ing. Honest broken
   beats clean and wrong.
2. **The code is the design.** Anything shown must be readable back out of real
   source, and any structural edit must land in that source immediately. Never
   present a view the code cannot substantiate.
3. **Show what actually happened.** Animation, metrics, and verdicts come from a
   run that occurred — a real trace, real tokens, real contention — not from a
   plausible model of one.
4. **Two altitudes, one continuous surface.** System-level fabric and block-level
   microarchitecture are the same design at different zoom; moving between them
   should feel like drilling down, not like changing tools.
5. **Density serves the expert; legibility serves the newcomer.** Design for the
   architect's information density first, and earn the student's understanding
   through structure and visible causality rather than by removing information.
