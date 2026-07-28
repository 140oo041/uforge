# Two-stage transport: a flit-level NoC over an IP-design canvas

## Context

`micro_arch_ide2` is an SoC architecture-exploration tool. Today it has **one**
transport model: a flat graph of `Component`s joined by `Link`s, with whole
`Event` packets moved through a single global-cycle calendar, and an optional
`Router` interposed. Inter-tile dataflow is authored as ordered per-router
forwarding rules; a route's endpoint is guessed by *"who consumes this message
type"* (`packages/contracts/src/fabric.ts:262-285`).

That model cannot answer the questions the tool exists to ask. Concretely:

- **No flits.** `Event::bits` only meters a router port's per-cycle bit budget. A
  packet is never fragmented, never occupies two routers, and nothing downstream
  can push back on it. Latency stays optimistic at every offered load, so
  "how many routers?" and "which topology?" have no measurable answer.
- **No backpressure.** `FullPolicy::Stall` reschedules a packet *to itself* at
  +1 cycle and never tells the upstream sender (`engine/src/router.cpp:127-134`);
  `router.hpp:59` explicitly disclaims credit-based flow control.
- **One clock.** One `Scheduler`, one `Cycle`, every clocked component ticking
  every cycle. The word "frequency" does not appear in the repo. A 60 MHz USB
  tile beside a 2 GHz core is inexpressible.
- **No address map.** Ranges are re-authored per router with nothing
  cross-checking them, so overlaps and gaps are undetectable — robot_soc has a
  live overlap at `0x1000` today, silently resolved by first-match.
- **Two memory banks in one tile are indistinguishable**, because destination
  resolution is by message type with `io:'in'` pins as the only tiebreak.

The outcome is a tool with **two named stages** — a synchronous, flit-level
**NoC stage** that connects tiles, and an event-driven **IP design stage** that
models microarchitecture inside a tile — and a five-phase flow across them:
add tiles → define memory → design communication → simulate → design IP.

## Settled decisions

| # | Decision |
|---|---|
| 1 | **Wormhole flit transport with virtual channels.** Head/body/tail; head allocates route+VC, tail releases. Credit-based flow control. |
| 2 | **VCs belong to the router, not the link.** Each router declares its input VC count and buffer depth; upstream credit counters size themselves from the downstream declaration, so heterogeneous VC counts are legal. **Virtual networks stay a fabric-level invariant** — a validator flags any router whose VC count is below the vnet count, else protocol deadlock returns. |
| 3 | **Fine integer timebase** (ps-scale ticks) + per-domain period/phase from an authored MHz. `runCycle` becomes event-driven: `next = min(next calendar entry, min over domains of nextEdge)`. Latencies stay authored in domain cycles. CDC latency emerges from arrival snapping to the next destination edge. |
| 4 | **Global address map is the single source of truth.** The NI decodes the region at injection and stamps a destination; routers only route known destinations. Per-router tables are derived. Per-region route override is the escape hatch. |
| 5 | **Phases guide, never gate.** Readiness is reported and navigable; nothing is ever locked. |
| 6 | **Flits move on synchronous channels, tick-driven.** The calendar is touched only at NI injection and ejection — never per flit-hop. This is what keeps per-flit cost flat. |
| 7 | **Two-phase evaluate/commit.** All routers compute next-state from current-state, then all commit. Order-independent; no flit crosses two hops in one cycle. |
| 8 | **Two fidelity modes** (gem5 Simple vs Garnet): `fast` (packets whole, occupancy derived) and `accurate` (full wormhole+VC+credits). One model, one trace schema, one metric set, two router cores. |

**Structural mapping:** a *tile* is an existing top-level component
(`parent === null && kind !== 'router'`) gaining a `tileClass`. NoC stage is the
canvas root; IP stage is drilled into a tile. `handler()` stays exactly as-is for
IP blocks; the NoC becomes synchronous. **The network interface is the adapter
between the two worlds** — that is the seam that makes "two stages" real rather
than cosmetic.

---

## Scope: what v1 builds

**In v1:**

| Area | Delivered |
|---|---|
| Engine | Wormhole flit transport with virtual channels · credit-based flow control · synchronous tick-driven channels (calendar only at NI inject/eject) · two-phase evaluate/commit · deadlock watchdog with dependency-cycle reporting · dense `PortId`s (fixes the existing allocator-order nondeterminism) |
| Time | Fine integer ps timebase · per-domain period/phase from authored MHz · event-driven scheduler with time-jumping · CDC by edge snapping |
| Model | Tiles + tile classes · global address map with region→(tile, interface) · clock domains · vnets · per-router VC count and buffer depth · topology as a macro intent · `schemaVersion` and a three-outcome `loadModel` |
| Derivation | `deriveNetwork` — dense `NodeId` table, derived per-router forwarding, 13 diagnostics including overlap/gap/unreachable/`vcBelowVnetCount`/`bufferDepthBelowCreditRoundTrip` |
| Fidelity | Two router cores — `fast` (packets whole) and `accurate` (full wormhole+VC), selected in `RunConfig`, not the sidecar |
| Analytics | Interval-accumulated per-port aggregates · engine-side latency histograms · sampled-token overview hops · flit ring buffer with triggers · **detail regenerated by deterministic replay** |
| UI | Phase strip (reporting only, never gating) · address-map editor · VC card · read-only derived forwarding table · topology picker · clock-domain and vnet authoring · tile classes |
| Migration | `migrate.ts` with interval subtraction of first-match rules, `iface` filled by running the retired heuristic once, `assumedValue` diagnostics for anything invented |

**Explicitly not in v1** — see *Deferred* at the end for the reasoning.

---

## Vocabulary

Load-bearing, because three words get used loosely and they are not synonyms:

| Term | What it is | Where |
|---|---|---|
| **`Event`** | a message between blocks — the existing C++ base class | both stages |
| **packet** | an `Event` **in transit across the NoC** | NoC stage only |
| **flit** | a fixed-width slice of a packet, `N = ceil(bits / flitBits)` | NoC stage only |
| **token** | the transaction id threading one journey across **both** stages | both |

An `Event` between two blocks **inside** one tile is never a packet: it rides a
`Link` through the calendar to `handler()`, exactly as today. An `Event` becomes
a packet only when it leaves its tile, and **it is the same object throughout** —
the tail flit owns the `unique_ptr<Event>` and the receiving NI hands that exact
object to the destination's `handler()`. Packetization is a transport wrapper,
not a conversion. That is what makes "the IP stage is untouched" literally true.

Corollary for §Stage 5: a **token** spans both stages, so sampling by token
yields the complete story of a transaction at both levels — and it bounds
intra-tile hop records, which `Link::send` emits today and which have the same
unbounded growth as NoC hops.

---

## Constants, defaults, and derivations

**Rule: no magic number appears inline.** Every quantity below is one of three
things, and which one it is must be obvious at the definition site:

- **Authored** — a model field the user sets. Has a named default constant.
- **Derived** — computed from the design. Never has a default; if it can't be
  computed, that is a diagnostic, not a fallback.
- **Fallback** — used only when there is genuinely no basis to derive. **Every
  use raises an `assumedValue` diagnostic naming the field and the reason.**

Constants live in **one** module, `packages/contracts/src/noc.ts`, mirroring the
role `bits.ts` already plays as "the single source of truth" for widths — the
host bakes values into generated C++ and the engine only reads them back. No
C++-side duplicate of any of these.

| Quantity | Kind | Rule |
|---|---|---|
| `flitBits` | **Derived** → fallback | `gcd(authored portBandwidthBits ∪ event bits)`. `FALLBACK_FLIT_BITS` only when nothing is authored. |
| `port.widthFlits` | Authored | default `DEFAULT_PORT_WIDTH_FLITS` |
| `router.vcCount` | Authored | default `max(vnetCount, MIN_VCS_PER_ROUTER)` — floors on the vnet invariant, so the default can never trip `vcBelowVnetCount` |
| `router.bufferDepthFlits` | **Derived** | `RT₀(router, port)` — the **zero-load** credit round trip (`forward + 1 + return + apply`). The same quantity `bufferDepthBelowCreditRoundTrip` validates, so the default is correct by construction. Note the scope: this sizes the buffer to saturate an *otherwise-idle* link. Under congestion the real round trip is `RT₀ + queueing`, which is dynamic and not statically checkable — that is what `credStall` measures, not what this validates. |
| `domain.mhz` | Authored | no default — a frequency the user did not state is not a frequency. Migration uses `FALLBACK_DOMAIN_MHZ` **and says so**. |
| `domain.syncDepth` | Authored | `DEFAULT_SYNC_DEPTH` (a 2-flop synchronizer is the conventional CDC default, but it is a *design* choice and belongs in the domain inspector) |
| `tickPs` | **Derived** | the largest quantum in which every authored domain period is an integer — i.e. `gcd(all periodPs)` after converting MHz. Never hardcoded; a 1 ps literal in the timebase example below is illustrative only. |
| `vnetCount` | Authored | starts at 1. Growing it is deliberate, with `vcBelowVnetCount` behind it. |
| `NodeId` | Fixed | `uint16` → **65 535 `(tile, iface)` endpoints**. A stated capacity limit, defined once in `flit.hpp`, asserted at table construction with a clear message rather than silently truncating. |
| `hopSampleEveryNthToken` | Authored | `DEFAULT_HOP_TOKEN_SAMPLE`. Trades animation density against trace size; sampling is by **whole token**, so a sampled packet's history is always complete. Aggregates are unaffected and remain exact. |
| `flitTrace.ringRecords` | Authored | `DEFAULT_FLIT_RING_RECORDS`; exceeding it within an interval emits `truncated`, never silence |
| `checkpointTicks` | Authored | `DEFAULT_CHECKPOINT_TICKS`. Governs flit-ring rotation only. (An earlier draft also tied metric keyframes to it; keyframes were dropped in favour of a parse-time index — see Stage 5.) |
| `metricSamples` | Authored | `DEFAULT_METRIC_SAMPLES`. **An accuracy knob, not just a size knob** — the emission interval is `runTicks / metricSamples`, so at 100 samples over 100k cycles a 200-cycle saturation burst reads as a 20% bump rather than a spike. Say so at the definition site. |
| per-VC metric tier | Authored | **off by default** — 1,280 series against tier A's 480 on the reference fabric |
| `DEADLOCK_WATCHDOG_TICKS` | Authored | must comfortably exceed the slowest domain's period, else a slow peripheral reads as a stall |
| `maxDeltaCycles_` | Existing | unchanged (1024, `scheduler.hpp`) |

Two existing constants keep their names and meanings: `DEFAULT_EVENT_BITS` and
`DEFAULT_BANDWIDTH_BITS` in `packages/contracts/src/bits.ts`. `DEFAULT_BANDWIDTH_BITS`
is retired with `portBandwidthBits` (Stage 2) — delete it rather than leaving a
constant nothing reads.

---

## Stage 0 — Scaffolding (no behavior change)

Everything here is permanent and makes later stages reviewable.

- **`schemaVersion` + a three-outcome `loadModel`.** Today it returns `null` for
  *both* "absent" and "corrupt" (`packages/host/src/writer/index.ts:261-299`),
  and both callers do `?? EMPTY_MODEL` (`ide/src/extension.ts:257`,
  `app/electron/session.ts:78`). A forward-incompatible sidecar therefore looks
  like a fresh project and gets **overwritten by the next write** — a live
  data-loss path in projects with no git. Replace with:
  ```ts
  type LoadResult =
    | { ok: true; model: AuthoringModel; migratedFrom?: number }
    | { ok: false; reason: 'absent' }
    | { ok: false; reason: 'newer'; version: number }    // refuse to write
    | { ok: false; reason: 'corrupt'; detail: string };
  ```
  Write `iss_authored.model.v<n>.json.bak` once before the first migration.
- **New pure module `packages/host/src/writer/migrate.ts`** — `migrate(raw) → {model, from}`.
  Move the three existing in-place migrations there as `migrateV0`. Keeps
  `writer/index.ts` the only fs-touching writer module and makes migration
  fixture-testable, which it is not today.
- **Extract `TEMPLATES`** from `packages/canvas/src/palette.tsx` into
  `packages/canvas/src/templates.ts`, exported from `index.ts`. `app/src/bench.tsx:44`
  currently re-declares the same 11 entries — permanent drift, fixed once.
- **Extract `isTile(c)`** into `packages/contracts/src/fabric.ts`. The predicate is
  already spelled out longhand at `inspector.tsx:314` and `fabric.ts:223`.
- **Split `ide/test/fabric.test.ts`** (878 lines) into `fabric.test.ts` (derivation),
  `router-codegen.test.ts`, and `e2e-fabric.test.ts` (the 5 tests that compile
  against `../engine`). Splitting before changing keeps every later diff readable.
- **Make `engine/tests/engine_tests.cpp` `main()` a table** (`{name, fn}` array + loop)
  instead of 33 hand-listed calls. ~25 more tests are coming.

---

## Stage 1 — Time model

### Types

```cpp
struct DomainCycle { std::uint64_t n; constexpr DomainCycle(std::uint64_t v = 0) : n(v) {} };
using Tick = std::uint64_t;          // ps-scale
using Cycle = DomainCycle;           // DEPRECATED ALIAS — do not remove
```

`DomainCycle` is **implicitly constructible from an integer** (`link->latency = 5`
is documented public API at `link.hpp:44`, and every generated block writes bare
numbers — authoring is in cycles, so a bare number *is* a cycle). There is **no
conversion between `DomainCycle` and `Tick` except through a `ClockDomain`**,
which turns "I added a cycle count to a tick" into a compile error.

**Keep the `Cycle` alias.** `writer/routerfile.ts:94` generates
`microarch::Cycle flat(const microarch::Event&)` and the *hand-owned tail below
the END marker* holds user latency models with that signature. The writer cannot
rewrite those.

### Scheduler

```cpp
Tick Scheduler::nextTick() const {
  Tick t = calendar_.empty() ? TICK_MAX : calendar_.begin()->first;
  for (const auto& d : domains_)
    if (!domainQuiescent(d)) t = std::min(t, d.edgeAfter(currentTick_));
  return t;
}

void Scheduler::step() {
  currentTick_ = nextTick();
  phase_ = Dispatch;                              // drain calendar_[currentTick_]
                                                  // KEEP the re-find-each-iteration loop
  for (auto& d : domainsWithEdgeAt(currentTick_)) {
    phase_ = Settle;                              // delta fixpoint, unchanged
    phase_ = Evaluate;                            // current-state only
    phase_ = Commit;
  }
}
```

`Component` gains two no-op virtuals (`evaluate(Tick)`, `commit(Tick)`) plus
`quiescent()` **defaulting to `false`** so the time jump is conservative and
correct out of the gate. **`tick(Tick)` stays** and is called during Commit for
non-NoC clocked components, so no existing block breaks.
`deliveryCycle`'s phase-aware zero-latency bump (`scheduler.cpp:51-56`) survives
verbatim in tick terms.

New: `engine/include/microarch/time.hpp` + `src/time.cpp` — `ClockDomain{name,
periodPs, phasePs, syncDepth}`, `edgeAtOrAfter`, `cycleOf`, `tickOfCycle`, `snapUp`.

### Trace, and the one silent failure mode

**Emit a mandatory first-line timebase record** (values illustrative — `tickPs`
and every `periodPs` are derived from the authored MHz, per *Constants*):
```json
{"timebase":{"tickPs":<derived>,"domains":[{"name":…,"periodPs":<derived>,"phasePs":…,"syncDepth":…}]}}
```
`packages/host/src/trace/parse.ts:50-51` reads `depart`/`arrive` as-is. Feed it
tick-scale numbers with no timebase and the playhead is 1000× off — the animation
looks frozen and **nothing errors**. `parseTrace` must reject a trace without a
timebase.

**Rename `Trace.cycles`/`ranCycles` → `ticks`/`ranTicks`.** Do *not* keep `cycles`
as a derived alias; a compiler-enforced rename over ~10 call sites is far cheaper
than one silent 1000× error. Call sites: `contracts/trace.ts`,
`host/trace/parse.ts:56`, `host/trace/synthesize.ts` (**easy to miss** —
`run.ts:148` falls back to it), `host/trace/vcd.ts`, `host/project/run.ts:136`
(the `/ran (\d+) cycles/` scrape), `canvas/metrics.ts`, `canvas/tokenAnim.ts`,
`canvas/useDesignSession.ts:206-225`, `canvas/shell.tsx`, `canvas/bottom-panel.tsx`,
`canvas/waves.tsx`.

**Display stays in cycles** — users authored MHz, they should read cycles, with a
ns readout in the status bar.

Also in this stage: fix `engine/examples/pipeline.cpp:100` (it is in the `all`
target, so bare `make` breaks even though `simulate()` calls
`make build/libmicroarch.a` and would still pass); update `svadapter.ts` so the
Verilated twin clocks on *its* domain's edge and its **VCD timescale equals
`tickPs`**; migrate `trafficfile.ts` from tick-polling to calendar-scheduled
bursts (required for real time jumps — it perturbs the xorshift sequence, so eat
the trace diff once, here).

**Acceptance:** robot_soc and sample traces identical to today up to a uniform
×1000 on every tick field.

---

## Stage 2 — Address map + tiles (pure TS, engine untouched)

### Model — `packages/contracts/src/model.ts`

`AuthoringModel` has nowhere to put design-wide config today. Add one:

```ts
export interface AuthoringModel {
  schemaVersion: number;
  components: AuthoredComponent[];
  events: AuthoredEvent[];
  design?: DesignConfig;              // absent from EMPTY_MODEL (avoid nested aliasing)
}

export interface DesignConfig {
  clockDomains: ClockDomainSpec[];    // { id, label?, mhz, phasePs?, syncDepth? }
  addressMap: AddressRegion[];        // a SET sorted by base — not an ordered list
  vnets: VirtualNetwork[];            // { index, label, messages?: string[] }
  noc: { flitBits: number; topology?: { kind, rows?, cols? } };
}

export interface AddressRegion {
  id: string; label?: string;
  base: string;                       // canonical 0x-hex, BigInt-compared, never a JS number
  size: string;                       // size, not `hi` — natural for power-of-two maps
  target: string;                     // TILE id
  iface?: string;                     // an EXISTING io:'in' pin under the tile
  vnet?: number;
  routeOverride?: string[];           // decision 4's escape hatch
}
```

**`region.iface` names an existing `io:'in'` pin — do not invent a new interface
concept.** That single field is the entire fix for two-banks-in-one-tile: the
region says *which pin*, explicitly, replacing the heuristic at `fabric.ts:262-285`.

On `AuthoredComponent`: add `tileClass?`, `clockDomain?`, and (routers)
`vcCount?`, `bufferDepthFlits?`, `ports?: Array<{name, widthFlits?, latencyCycles?}>`.
`routerLatency` keeps its name, redefined as pipeline depth in domain cycles.

**Retirements:** `ForwardingRule`/`rules` (→ address map), `portBandwidthBits`
(→ `flitBits × widthFlits`; two knobs for one quantity will disagree),
`queueCapacity` (→ `bufferDepthFlits`), `fullPolicy: 'stall'` (credits make a
full buffer un-enterable — `Stall` is precisely what decision 1 replaces),
`latencyModel` on ports and rules (models key on port now, not destination).

**Intents:** `+setTileClass`, `+add/remove/setClockDomain`, `+assignClockDomain`,
`+add/update/removeRegion`, `+setRegionRouteOverride`, `+setNocConfig`,
`+add/removeVnet`, `+assignMessageVnet`, `+setRouterVc`, `+applyTopology`,
`+setPortDestination`. Retire the four `*ForwardingRule` intents,
`setRouterBandwidth`, `setRouterQueue`, `setWireLatencyModel`.

**No `moveRegion`** — regions are a set with overlap as a hard error. Retiring
ordered first-match also removes the `↑↓` affordances and "rule N" from every
diagnostic.

**`applyTopology` is a macro intent** that expands inside `applyIntent` into
ordinary *authored* routers + `peers` + attachments. Derived routers would lose
layout persistence (`iss_layout.json` is keyed by id), the per-router `src/<R>.cpp`,
the inspector, and undo. One intent = one undo entry.

### `deriveFabric` → `deriveNetwork`

Same file (`packages/contracts/src/fabric.ts`); rename the function to signal the
semantic break without a rename cascade through `GraphFabric`/`FabricDiagnostic`/
`augment.ts`/both run gates.

**Survives:** the cross-top wire ban (phase 1, verbatim), `routerPath` BFS with
sorted-peers determinism, `topOf`.
**Deleted:** destLeaf-by-message-consumption including the `io:'in'` tiebreak.

Output gains `nodes` (a dense, sorted, stable `NodeId` table over `(tile, iface)`),
`regions` (resolved + overlap-checked), `topology.links`, `forwarding` (the derived
per-router next-hop tables), `domains`, `vnets`, `flitBits`.

**Diagnostics 8 → 13.** Kept: `crossTopWire`, `ambiguousIngress`. Renamed:
`unattachedTop`→`unattachedTile`, `noTrunkPath`→`unreachableRegion`,
`unresolvableRuleDest`→`regionTargetMissing`/`interfaceMissing`. Retired:
`unmatchedPort`, `ambiguousRuleDest`, `conflictingLatencyModel` (all structurally
impossible now). **New:** `regionOverlap` (error), `regionGap` (warning; error if
a traffic gen's range intersects the hole), `unreachableRegion`,
`unaddressedTraffic`, `vcBelowVnetCount` (error — decision 2's invariant),
`bufferDepthBelowCreditRoundTrip` (error at depth 0/1, warning below round trip),
`vnetNotAssigned`, `topologyDisconnected`, `domainUnassigned`, and
**`assumedValue`** (warning) — carries `{field, value, reason}` for anything a
migration or a fallback invented rather than derived. See *Constants* below.

Verified: both run gates filter on `severity === 'error'` only
(`ide/src/extension.ts:441`, `app/electron/session.ts:283`) and every renderer
switches on `severity`/`detail`, never `kind`. **New kinds flow through both hosts
with zero host changes.**

### Deliberate throwaway

The harness generates the *existing* `addMatchRule` calls **from the map** — a
~20-line emitter in `writer/harness.ts`, deleted at Stage 4e. It is what makes
this stage independently landable with zero engine risk.

**Acceptance: robot_soc and sample traces byte-identical to Stage 1's.** This is
a semantics-preserving refactor and the migration below is designed to prove it.

### Migration (`migrate.ts`)

Verified on-disk state:
```
robot_soc R1.rules = [{fetchWord, 0x0..0x1000  → Memory4},
                      {fetchWord, 0x1000..0x3000 → Memory1}]   ← OVERLAP at 0x1000
robot_soc Gen1.traffic = { addrLo: 0x1000, addrHi: 0x1fff, random }
robot_soc R2 = { portBandwidthBits: 96, arbitration: weighted }
sample    R1.rules = [{Out1ToMemory1Event → Memory1}]           ← no address bounds
```

1. Walk each router's rules in order; for each with address bounds emit a region,
   and **run the retired destLeaf-by-consumption heuristic one last time, at
   migration time, to fill `iface`.** The heuristic is exactly what converts
   implicit knowledge into explicit data. It runs once and never ships in a
   production path.
2. **Interval-subtract** each later rule's range by the union of all earlier ones
   — that *is* first-match semantics rendered as a non-overlapping set:
   - `{base 0x0, size 0x1001 → Memory4}`
   - `{base 0x1001, size 0x2000 → Memory1}`

   Gen1 draws `[0x1000, 0x1fff]`: `0x1000 → Memory4`, `0x1001..0x1fff → Memory1`
   — identical to today. Watch the off-by-one: `size = hi − lo + 1` in BigInt,
   before subtraction.
3. Rules with **no** address bounds (sample) become **port destination overrides**
   via `setPortDestination` on each fabric-bound port whose message matches. This
   is why the escape hatch must exist.
4. **`flitBits` is derived, not chosen.** robot_soc's `R2` sets 96 bits; at a
   128-bit flit that rounds to 1 flit = 128 b/cy, a silent 33% increase.
   Compute `flitBits = gcd(all authored portBandwidthBits ∪ all event bits)` —
   for robot_soc that yields 32, giving `widthFlits = 3` = exactly 96. When
   nothing is authored there is no basis for a value: fall back to
   `FALLBACK_FLIT_BITS` and **emit an `assumedValue` diagnostic** naming the
   field and the reason. Never let an invented width pass silently.
5. Clock domains: one domain, nothing assigned — this is what keeps Stage 1 a
   pure scale factor. **Old designs contain no frequency, so any number here is
   fiction.** Set `mhz = FALLBACK_DOMAIN_MHZ`, mark the domain `assumed: true`,
   and raise `assumedValue`. The status bar and the phase strip both surface it
   until the user sets a real frequency.
6. **vnets default to exactly ONE.** Two would trip `vcBelowVnetCount` on every
   migrated router at load; adding the second is a deliberate act with the
   validator behind it. `vcCount = max(vnetCount, MIN_VCS_PER_ROUTER)`.
   **`bufferDepthFlits` is computed, not guessed:** the credit round trip is
   `channelLatency × 2` (forward + credit return), so the default is
   `creditRoundTrip(router, port)` — the smallest depth that does not
   throughput-cap the link. That is the same quantity
   `bufferDepthBelowCreditRoundTrip` validates against, so the default is
   correct by construction rather than by taste.
7. **Set no tile classes** — a name heuristic doesn't belong in production
   migration code. Hand-edit robot_soc and sample in the same commit.

The migration returns a **report** (`{field, value, reason}[]`) alongside the
model. Both hosts log it once on open. A migration that assumed anything says so.

Note robot_soc also has `Gen1ToMemory2Event`, `Memory1ToMemory3Event` etc.
consumed but covered by **no rule** — they bind ingress, raise `unmatchedPort`,
and drop at runtime today. The demo is partly broken; migration is when to make
it coherent.

---

## Stage 3 — Topology, VC/vnet, clock-domain authoring (inert config)

Author everything the engine doesn't consume yet, plus every validator from the
diagnostics list. Landing it here means Stage 4 is exercised by real UI-authored
designs rather than hand-written JSON. **The phase strip lands here**, since all
five phases finally have data.

---

## Stage 4 — The NoC engine

### New files (flat — see the Makefile hazard)

| Header | Source | Contents |
|---|---|---|
| `time.hpp` | `time.cpp` | (Stage 1) |
| `flit.hpp` | `flit.cpp` | `FlitType{Head,Body,Tail,HeadTail}`, `Flit`, `PacketId`, `NodeId` |
| `addrmap.hpp` | `addrmap.cpp` | `Region`, `AddressMap::decode(uint64)→NodeId` (sorted vector + binary search, asserts non-overlap) |
| `channel.hpp` | `channel.cpp` | synchronous register pair + reverse credit path |
| `nocrouter.hpp` | `nocrouter.cpp` | `NocRouter`, `RouterCore`, `WormholeCore`, `StoreForwardCore` |
| `netif.hpp` | `netif.cpp` | `NetworkInterface` |
| `topology.hpp` | — | port-id/neighbour helpers, header-only |

**Makefile hazard:** `engine/Makefile:16` is `$(BUILD)/%.o: src/%.cpp` with no
`mkdir -p $(@D)`. Sources under `src/noc/` fail with "No such file or directory".
**Stay flat** (matches the existing 8 headers). Headers may nest safely.

```
SRCS := src/scheduler.cpp src/link.cpp src/trace.cpp src/time.cpp \
        src/flit.cpp src/addrmap.cpp src/channel.cpp src/nocrouter.cpp src/netif.cpp
```
(`src/router.cpp` stays until 4e.)

### Flit

**Do not carry `std::string dest` per flit.** Resolve to a dense `NodeId`
(uint16 index over `(tile, iface)`) at NI injection; routers then index a
`std::vector<PortId>`. O(1), no per-hop string hashing, and **deterministic** —
unlike today's `std::map<std::string, Component*> routes_` +
`std::map<Component*, Queue> queues_`.

```cpp
struct Flit {
  FlitType type; TokenId token; PacketId packet;
  std::uint16_t vc; std::uint8_t vnet;
  NodeId dest; NodeId origin;
  std::uint64_t addr; std::uint32_t bits;
  std::unique_ptr<Event> payload;      // tail (or HeadTail) only
};
```
The `Event` rides the tail and is handed to `handler()` at ejection — that is
what preserves the IP stage unchanged.

### Router

```cpp
class NocRouter : public Component {
public:
  void handler(Event&) override;        // throws — nothing enters a router by calendar
  void evaluate(Tick) override;         // current state only
  void commit(Tick) override;
  bool quiescent() const noexcept override;
private:
  std::unique_ptr<RouterCore> core_;    // Wormhole | StoreForward
};
```

**Fidelity is injected, not inherited.** `routerfile.ts` emits
`class R1 : public microarch::NocRouter` regardless of mode; the mode arrives in a
config struct from the harness. Consequence: **fidelity lives in `iss_run.json`
(RunConfig), not the sidecar** — flipping fast/accurate must never rewrite `.cpp`
files. This is what keeps decision 8 cheap.

Shared code (ports, forwarding, arbiter, credits, metrics) lives in `NocRouter`;
cores override only the per-port evaluate body. `StoreForwardCore` = whole packets
with `ceil(bits / flitBits)` cycles of channel occupancy — same substrate, so
"one trace schema, one metric set" is structural rather than a convention.

**Evaluate**, per input VC holding a flit: route compute (head only,
`fwd_[flit.dest] → PortId`) → VC alloc (head only, a free downstream VC whose
vnet matches) → switch alloc (existing DRR/RR/priority logic, now keyed on
`NodeId origin`) → if `credit_[port][vc] > 0`, write `out.next_` and decrement.
**Commit:** swap every channel, apply incoming credits, release the VC on tail.

Credit sizing lives in the **engine**, not codegen: at wiring time each router
reads `neighbour.declaredBufferDepth(inPort, vc)`. That is decision 2 realised —
heterogeneous VC counts need no codegen awareness at all.

**Determinism fix, same commit as evaluate/commit:** dense `PortId`s assigned at
config time in sorted-by-name order, replacing `std::map<Component*, …>` for
`queues_`, `credit_`, `rrCursor_`, `deficit_`, `lastReportedDepth_`, `stallCount_`.
Ship evaluate/commit without this and you claim order-independence while metric
emission order still varies by allocator address.

### `Link`

Kept, and stays THE single transport funnel for **IP-stage** wires. Gains a
`const ClockDomain*` so `latency` converts. `routeVia(Component&)` /
`routeVia(Component&, std::string)` collapse to `routeVia(NetworkInterface&)`;
`finalDest_` disappears (the NI decodes). `divert()` untouched.

**`Link` is not used inside the NoC.** That is the seam: `Link` = calendar
transport, `Channel` = synchronous transport, `NetworkInterface` = adapter.

### Backpressure into the NI — a design hole to close

Backpressure must terminate somewhere and a calendar-driven `handler()` cannot be
stalled. **Default: an unbounded injection queue with `injectDepth` emitted as a
metric** so the unboundedness is visible; drop-and-report as opt-in per NI. Retire
reschedule-to-self. `QueueFullPolicy` survives as a type *only* for this queue.

### Deadlock detection — an engine feature, not a test expectation

Credits guarantee no flit is ever *lost*; they guarantee nothing keeps *moving*.
When every VC on a path is blocked waiting for a credit that depends on a flit
that is itself waiting for a credit, the effective round trip is infinite and the
simulation makes no further progress. Without detection the observable symptom is
a hang, and the user's conclusion is "the tool is broken" rather than "my fabric
deadlocks" — which is the single most valuable thing this stage can tell them.

Add a watchdog to `Scheduler`: if no flit moves on any channel and no calendar
event fires for `DEADLOCK_WATCHDOG_TICKS` while packets are still in flight,
stop and emit a `DivergenceRecord` with `kind = "deadlock"` carrying the
dependency cycle — for each blocked VC, what it waits on and which router owns
it. Walking the wait-for graph at the moment of detection yields the cycle
directly, and printing it is what makes a 1-vnet request/response failure legible.

`DEADLOCK_WATCHDOG_TICKS` is authored (`RunConfig`) with a named default; it must
comfortably exceed the slowest domain's period so a slow peripheral is never
mistaken for a stall. A run that ends this way is a **reported failure, not a
crash** — the trace is still written and the canvas still replays up to the stall.

### Sub-stages

- **4a** `time`/`flit`/`channel`/`addrmap` + unit tests, zero integration.
- **4b** `NocRouter` + `StoreForwardCore` + dense ports + metrics.
- **4c** `WormholeCore`. Tests: single flit; multi-flit ordering; credit
  backpressure; **two packets on one VC must not interleave** (the wormhole
  invariant); tail releases VC; 2-vnet no-deadlock under a request/response
  cycle; heterogeneous VC counts across a 3-router chain.
- **4d** `NetworkInterface`: packetise, inject, eject, CDC snap. Include a test
  asserting `scheduler.pending()` does **not** grow during multi-hop transit —
  decision 6 made executable.
- **4e** **Cutover.** Harness emits NIs + NocRouters + Channels + the region
  table; delete `router.hpp`/`router.cpp` and their 22 tests; Makefile final;
  demos re-run. Have `routerfile.ts` detect a
  `microarch::Cycle <name>(const microarch::Event&` tail and emit a loud
  migration banner inside the regenerated marker region — the latency-model
  signature changes to `const Flit&` and the `Cycle` alias saves the type, not
  the signature.
- **4f** Trace/metrics (Stage 5).

---

## Stage 5 — Trace and metrics

### The organizing idea: store little, regenerate on demand

Detail is not stored — it is **regenerated by deterministic replay**. The run
writes interval aggregates plus a small overview layer; any finer view (per-VC
metrics, per-flit records, full packet hops) is produced by **re-simulating the
window you are looking at** with that recording level enabled.

**This is only sound if replay is exact**, which three decisions already made
deliver — two-phase evaluate/commit (order-independent), dense `PortId` arrays
(no allocator-order dependence), and the integer timebase (no float comparison
in the calendar) — plus the existing seeded xorshift. Determinism stops being
incidental and becomes load-bearing, so it needs its own test: **run twice,
assert byte-identical traces.**

**Invariant: observation must not perturb the simulation.** If enabling per-VC
recording shifted timing by a cycle, a replay would diverge from the original run
and the user would be debugging a different execution. Recording must be strictly
side-effect-free — tested by running with and without it and asserting identical
aggregates.

**v1 replays from cycle 0; no state snapshots.** At ~10⁶ cycles/sec, reaching any
point in a 100k-cycle run costs ~1.6 ms and replaying the whole run ~100 ms.
Restorable checkpoints would mean serializing every VC buffer's contents, credit
counters, arbiter cursors, channel registers, the calendar (polymorphic
`unique_ptr<Event>`, so every generated event class needs generated
serialize/deserialize) and all block state — substantial machinery to save
milliseconds. Snapshots become worthwhile past roughly 200 ms of replay (~10M
cycles) and are a **later optimization behind an unchanged interface**: "give me
full detail for this window." The eventual form is the hybrid `rr` uses —
periodic snapshots plus replay from the nearest one.

**When that day comes, the blocking hazard is not the engine — it is
hand-written block state.** Parser rule V1 recognises only
`<type> <name> [= init];` at class depth 1, so state a user declares any other
way (a `std::vector`, a nested struct, a static) below the END marker is
invisible to the model. A snapshot built from the model would omit it silently
and the restore would *diverge rather than fail* — the worst failure mode
available. Any snapshot work must start by deciding how blocks declare their own
serialisable state, not by serialising the router.

**Replay emits nothing until it reaches the window.** Recording is off for the
seek, so the data produced is bounded by the window, not by how deep into the run
it sits:

```
simulate 0 ─────────────▶ 95,000    recording OFF — pure compute, ~95 ms
simulate 95,000 ─▶ 96,000           recording ON  — 1k cycles of detail
```

```
storage = O(window)      time = O(position)
```

Snapshots convert the time term to `O(window)` by paying storage for a restore
point. That is the only thing they buy — which is why they wait.

**The volume problem was always level × duration, never level.** Bound the
duration and any level is cheap:

| View | over 100k cycles | over a 1k window |
|---|---|---|
| per-flit hops | 1.2M ≈ 132 MB | **~12k ≈ 1.4 MB** |
| all routers, all VCs, per cycle | 64M | ~640k |
| **one port's VCs, per cycle** | 640k | **~8k** |

Two invariants make this hold:

- **Recording is scoped by (window, subject, level)** — expanding port N records
  *that port's* VCs for *that* interval, not all 16 routers. The scope comes from
  what the user clicked.
- **Regenerated detail is transient** — a query result streamed to the UI, never
  written to the trace. The permanent record stays ~5 MB regardless of how many
  ports are expanded or windows inspected. Nothing accumulates on disk.

**Stated limit:** full flit detail for the *entire* run cannot be resident at
once (132 MB) — by design, since inspection is inherently windowed. The class of
question this does not serve is the global fine-grained one ("every flit that
ever waited > 20 cycles"), which wants an engine-side **filtered pass** over the
whole run emitting only matches. That is a third query mode, not a variant of
replay, and it is out of scope for this plan.

Interaction this enables:

```
playing 1k → 1.56k        reading stored per-port aggregates
    ↓ port N looks wrong
expand port N             replay [1k, 2k] with per-VC recording on, for that port
    ↓ ≈ 2 ms
per-VC occupancy, credit stalls, VC allocation across the window being watched
```

The same mechanism serves "show me the flits" at any zoom — flit detail is just
another recording level on the same replay.

### What is stored

**Four layers — and note that raw events survive for the whole run only at
*sampled-token* granularity. Everything finer is regenerated:**

| Layer | Granularity | Coverage | Why it exists |
|---|---|---|---|
| timebase | once | — | units; without it the playhead is silently off by the tick scale |
| **packet hops** | per packet per hop | **sampled tokens, whole run** | drives `tokenAnim.ts`, which needs a real event per packet per hop |
| flit ring | per flit | recent interval, on trigger | causal debugging of acute failures |
| aggregates + histograms | counters | **every packet**, whole run | metrics, saturation, latency distributions |

**Nothing in the trace may grow without bound.** Retaining every packet hop for
the whole run is `O(packets × hops)` — 400k records ≈ 48 MB on disk and ~120 MB
resident for a modest run, and linear in cycles and tiles from there. That is
the same unbounded curve as per-flit records with a smaller constant, not a fix.

The observation that bounds it: **the canvas cannot draw 100k tokens.** At any
playhead position only the packets in flight are visible — dozens. So:

- **Sample whole tokens, never individual hops.** Token ids are monotonic
  (`nextToken_++`), so "every Nth token" is deterministic and replay-stable.
  Emit *all* hops of a chosen token and *none* of the others.
- Keeping tokens intact is what preserves both `tokenAnim.ts` (it groups by
  token) and the undelivered-hop warning (`run.ts:152-160`) — a sampled token's
  history is complete, so neither degrades.
- **Aggregates still count every packet.** The animation is representative; the
  numbers are exact.

Budget on the reference workload (16 tiles, 4×4 mesh, 100k cycles, 100k packets,
mean 4 hops, mean 3 flits/packet, ~3 intra-tile Events per transaction):

| Level | Raw, if kept in full | Stored | Regenerated by replay |
|---|---|---|---|
| flit | 1.2M flit-hops ≈ 132 MB | ring only (last interval) | ✔ any window, any port |
| packet | 400k hops ≈ 48 MB | 2k sampled tokens × 4 = **8k** | ✔ all tokens, any window |
| event | 700k hops (300k intra-tile + 400k inter) | same sampling = **6k** | ✔ |
| token | 100k transactions | **2k** sampled (1 in 50) | ✔ |
| aggregates, per port | — | **~48k** (100 intervals) | — permanent record |
| **aggregates, per VC** | — | **never** | ✔ **on expand** |
| histograms | — | **~1.6k** | ✔ finer bucketing on demand |

**≈ 64k records ≈ 5 MB on disk**, against ~1.9M records / ~180 MB raw.

Two properties hold this up:

1. **Every stored layer is bounded by a count, not an interval**, so trace size
   is `O(1)` in run length and `O(routers)` in fabric size. A 10× longer run
   produces the *same* trace at coarser resolution.
2. **Resolution lost to (1) is recoverable by replay.** The coarse permanent
   record is not a compromise on what you can see, only on what you can see
   *without re-simulating* — which is why aggressive interval sizes are safe here
   in a way they would not be in a store-everything design.

The sampled-token layer exists so that scrubbing the whole run for an overview
does not trigger continuous re-simulation. 8k records buys a zero-latency
overview; replay is reserved for zooming in.

Costs, stated: hop-derived path-latency becomes a sample (moot — the plan already
moves those to engine-side `HistogramRecord` over every packet, which is
strictly better), and chasing one specific packet requires it to have been
sampled (which is the flight recorder's job, and it ignores sampling).

**Aggregates are not merely a compression of the events.** `vcOcc`, `credStall`
and `hol` have no event-level footprint at any granularity — they are a different
measurement, wanted even with unlimited storage. Only `flow`, `bits` and `qdepth`
could in principle be re-derived from raw events.

1. **Timebase record** — mandatory first line (Stage 1).
2. **Packet-level hops by default.** `HopRecord` keeps
   `{from,to,event,token,depart,arrive,addr}` in ticks and gains `bits`, `vnet`,
   `flits`. One per router hop, emitted at **head departure** with `arrive` =
   tail arrival. **This preserves `tokenAnim.ts` exactly** — a 141-line pure
   function with its own tests that groups by token and interpolates
   `[depart, arrive)`. Treat that as a hard constraint.
3. **Per-flit: a flight recorder, not a pre-declared window.** An in-memory ring
   buffer, always recording, dumped to the trace **on a trigger**. A declared
   window (`fromTick`/`toTick`) is kept as an option, but it cannot be the
   primary mechanism: for the failures that matter most — deadlock above all —
   you do not know the interesting tick in advance, so a declared window means
   discovering the problem and then re-running to look at it.

   **Triggers** are things the design already detects: watchdog fire, any
   `DivergenceRecord`, a metric crossing an authored threshold, and run end.

   **Checkpoints unify the two layers.** The metric keyframe boundary (below)
   *is* the ring-buffer boundary:

   ```
         checkpoint                                   checkpoint
             │                                             │
     metrics │ full snapshot of every metric               │ full snapshot
     flits   │ ─── ring: every flit since here ────────▶   │ (rotate)
   ```

   At any instant the engine holds the exact aggregate state at the last
   checkpoint plus every event since, so within the current interval a consumer
   can replay events onto the keyframe and recover full fidelity. One authored
   knob — the checkpoint interval — governs memory, metric-lookup cost, and
   detail resolution together.

   **Double-buffer the ring** (retain current + previous interval), or a trigger
   firing just after a checkpoint yields almost no history. Guarantees between
   1× and 2× the interval of detail.

   Bound the ring by record count (`DEFAULT_FLIT_RING_RECORDS`, authored); on
   overflow within an interval emit `{"truncated":true,"at":…,"dropped":…}` so
   silence is never mistaken for correctness.

   **Scope, stated honestly:** this captures *acute* failures — something
   happened, here is the run-up. It does not capture *chronic* ones ("throughput
   is 10% below expectation across the whole run" has no trigger), which still
   need an explicit window and a second run. It narrows the two-run loop rather
   than removing it.
4. **Engine-computed aggregates** — a `{"summary":…}` record at run end.
   `metricsSummary()` (`canvas/metrics.ts:149`) **prefers** it and keeps the
   hop-derived path as fallback, which also keeps existing metrics tests meaningful.

**Histograms get a sibling record, not a widened `value`** — `parse.ts:36`'s
`typeof obj.metric === 'string'` branch and the whole `sampleValuesAt` family
depend on the scalar shape:

```cpp
struct HistogramRecord {
  std::string metric, component, port;
  Tick tick;
  std::vector<std::uint64_t> bounds, counts;
  std::uint64_t n, sum, min, max;
};
```
Engine-side histograms are non-negotiable for per-flit latency quantiles — they
cannot be recovered from packet-level hops, and shipping every sample is exactly
what we're avoiding.

**New metric kinds:** `vcOcc` (per port per VC, change-only), `credStall`,
`vcStall`, `injectDepth`, `hol`. Keep `flow`/`bits`/`stall`/`qdepth` names where
the meaning survives so `metrics.ts:176` and the METRICS tab keep working.

**`credStall` must be attributable, or it's not an answer.** Credit starvation
has two unrelated causes that look identical in a single counter, so emit
`vcOcc` for the *downstream* buffer alongside it and let the METRICS tab classify:

```
credStall > 0  AND  downstream vcOcc < depth   →  undersized buffer (static, your fault)
credStall > 0  AND  downstream vcOcc == depth  →  congestion (dynamic, working as intended)
```

The first is the `bufferDepthBelowCreditRoundTrip` case showing up at runtime;
the second is backpressure doing its job. Reporting them as one number turns a
diagnosable design error into "the link is slow."

### Metrics must accumulate over intervals — per-tick emission is the largest layer

`router.cpp:306-319` emits `flow` and `bits` **per port per tick** whenever
nonzero. At robot_soc's two routers that is nothing. On the reference workload:

```
16 routers × 5 ports × 100,000 cycles × 2 metrics  =  16,000,000 records
```

which dwarfs every other layer — the opposite of the reason aggregates exist.
**Accumulate over an interval and emit the sum**, and make the knob a **sample
count, not an interval**:

```
metricSamples = 100                        (authored)
interval      = runTicks / metricSamples   (derived; RunConfig.cycles is known up front)
```

| Tier | Series (reference fabric) | Stored? | Records |
|---|---|---|---|
| **A** — per port: `flow`, `bits`, `occ`, `credStall`, `vcStall`, `hol` | 480 | **always** | ~48k |
| **B** — per VC: `vcOcc`, per-VC stalls | 1,280 | **never stored** — regenerated by replay on expand | 0 |
| Histograms — latency per router per interval | 16 | always | ~1.6k |

Tier B is the case the replay architecture is for: the data a user wants only
after seeing something suspicious, for one port, over one window. Storing 1,280
series against tier A's 480 to serve a question nobody asks most runs is the
wrong trade — regenerating it in ~2 ms is the right one.

**No keyframes.** An earlier draft added them to bound backward metric lookups.
They are unnecessary: `parse.ts` fully parses the file once regardless, so it
should build a per-series index while doing so —
`Map<seriesKey, {ticks: Uint32Array, values: BigUint64Array}>` — making a lookup
at tick T a binary search, `O(log n)`, no scanning. ~4 MB for 1,600 series.
Keyframes only help when seeking a file you have *not* parsed, which is not the
model here. Consequently `checkpointTicks` governs **only** the flit ring's
rotation.

---

## Stage 6 — UI

**Stage is derived, never stored:** `stage = currentPath === null ? 'noc' : 'ip'`,
`focusTile = topOf(currentPath)`. Note `currentPath` may be `"CPU0.Cluster0"` and
that is still IP stage. `useDesignSession.ts:149-155` documents the exact bug
class two sources of truth produce here.

- **Phase strip** — pure `packages/canvas/src/phases.ts`
  (`phaseReadiness(graph): PhaseState[]`) + thin `phase-strip.tsx`, matching the
  established pure-module pattern (`layout.ts`, `metrics.ts`, `tokenAnim.ts`).
  IDE: under `TabBar`. Electron: into the existing `ScopeBar` (`bench.tsx:703`)
  as a chip row. **Decision 5 is enforced by the type** — `PhaseState` carries
  `ready` and `summary` and *nothing a caller could use to disable anything*.
  No `blocked`, no `enabled`.
- **`EditorTab`** extends to `'design' | 'spec' | 'events' | 'memory' | 'fabric'`
  — an already-threaded extension point (`shell.tsx:5`, `ActivityBar`, `TabBar`,
  bench's `ScopeBar`).
- **`RulesCard` (`inspector.tsx:306-493`) is deleted**, split three ways:
  1. **Address map editor** (`address-map.tsx`, the `'memory'` tab) — built as a
     **map, not a form**: an address axis with contiguous bars, target tile +
     interface per bar, **gaps and overlaps rendered as visual space between
     bars**. Reuse `AddrField` and the `parseAddr`/`formatAddr` BigInt discipline
     verbatim.
  2. **Router inspector** keeps latency/arbitration/Attached/Trunks, gains a **VC
     card** (`vcCount`, `bufferDepthFlits`, per-vnet reservation, both validators
     inline) and a **read-only "Forwarding (derived)" card** in RulesCard's old
     slot showing the computed next-hop table with the path as the *why*. Users
     lose authoring; they must not lose visibility. Each row deep-links to its region.
  3. **Route override** lives on the region row, not the router.
- **Topology picker** — a modal from the NoC canvas, not a tab. It's a one-shot
  generator whose output is ordinary editable routers.
- **Clock domains, vnets, flit width** — into `inspector.tsx`'s nothing-selected
  branch, which is currently a dead end and becomes the "Design" inspector.
- **Tile class** — a select when `parent === null`, plus a canvas glyph extending
  the router's `◈` treatment (`canvas.tsx:884-1004`).
- **Fidelity mode** — `run-config.tsx`.

**Two-host discipline — target zero new `HostMsg`/`ViewMsg` variants.** Everything
above flows through the existing `{type:'edit', intent}` channel and
`setRunConfig`, so `ide/src/extension.ts:137-204` and
`app/electron/session.ts:150-236` need no changes at all. Per new surface:
every new canvas class needs a base rule in `packages/canvas/src/styles.css` (or
it renders only in Electron — the heat-overlay precedent); every new colour goes
through `var(--vscode-TOKEN, fallback)`; `bench.tsx` imports `TEMPLATES` from
`templates.ts` and gets checked for new tabs.

---

## Risks and ordering hazards

**Breaks first:** `engine/examples/pipeline.cpp:100` (in `all`, so bare `make`
fails in Stage 1) → the 5 e2e tests compiling against `../engine` →
**silently**, `parse.ts` reading tick-scale numbers as cycles.

**Hidden coupling, ranked:**
- `svadapter.ts` (309 lines) — clocks on its domain's edge; **VCD timescale must
  equal `tickPs`**. Most-forgotten item here.
- `synthesize.ts` — the `isThin` fallback (`run.ts:146-149`) must emit the new
  tick/timebase shape or the fallback silently produces an unscalable trace.
- `trafficfile.ts` — the tick-poll→calendar migration perturbs xorshift; robot_soc
  traces change. Do it inside Stage 1.
- `releaseActiveEvent()` re-entrancy — the dispatch loop re-finds
  `calendar_[currentTick_]` each iteration (`scheduler.cpp:102`). The NI's
  `handler()` needs the same `"event not stealable (nested dispatch?)"` guard as
  `router.cpp:130`.
- `parser/facts.ts` deliberately drops facts in free functions, so the address map
  is sidecar-only. Mitigation that also answers the "code is the truth" objection:
  generate the map into the harness **as data** (`static const microarch::Region
  kRegions[]`) — exactly where all fabric config already lives
  (`harness.ts:129-180`). The principle is preserved precisely as much as today.
- Keep `design` out of `EMPTY_MODEL` (nested-object aliasing across the many
  `{...EMPTY_MODEL}` sites).

**Ordering:**
- The **address map must land before the engine NoC** — the NI decodes against the
  NodeId table generated from the map. Engine first means a throwaway decode path.
- **Two trace-changing events stay in separate commits:** Stage 1's ×1000, and
  4e's port-order determinism fix. Compounding them makes the diff unreviewable.

**Test disposition:** of 33 engine tests, **22 router tests deleted at 4e**
(replaced by ~25 NoC tests); the 3 clock tests are *edited*, not deleted, in
Stage 1. Of `fabric.test.ts`, path-selection (109-129) and intent tests (51-108)
survive with renames; derivation (727-878) and codegen (130-416) are rewritten;
**the 5 e2e tests are the highest-value assets in the repo** — the only
end-to-end proof — and are rewritten last, at 4e, preserving their structure.
`metrics.test.ts` and `tokenanim.test.ts` survive **if** hops stay packet-level
with `depart`/`arrive` unchanged in meaning. `rules.test.ts` is deleted at
Stage 2, replaced by `addrmap.test.ts` + `migrate.test.ts`.

---

## Verification

**Per stage:** `npm test` (ide workspace), `npm run test --workspace app`
(**`npm test` at root does not run this**), `npm run typecheck`,
`make -C engine test`, `make -C engine` (catches `pipeline.cpp`), and both demos
opened and Run in each host.

**Stage-specific gates:**

| Stage | Gate |
|---|---|
| 0 | `migrate.test.ts` round-trips the real robot_soc and sample v1 sidecars. A `schemaVersion` newer than the build refuses to write and says so. |
| 1 | robot_soc + sample traces identical to today **up to a uniform ×1000**. A two-domain fixture proves CDC snapping: `arrive = destDomain.edgeAtOrAfter(sendTick) + periodPs × syncDepth`. A trace without a timebase record is rejected by `parseTrace`. |
| 2 | **Traces byte-identical to Stage 1's** after migration — the single acceptance test proving the address-map cutover is semantics-preserving. Plus: `regionOverlap` fires on a hand-authored overlap; robot_soc's `0x1000` overlap is resolved by interval subtraction, not carried. |
| 3 | `vcBelowVnetCount` fires when vnets go to 2 with a 1-VC router. `bufferDepthBelowCreditRoundTrip` fires at depth 1. Every validator has a test; nothing is gated. |
| 4c | Two packets on one VC do not interleave. A request/response cycle across 2 vnets does not deadlock; on 1 vnet it does — and the watchdog **reports it with the dependency cycle** within `DEADLOCK_WATCHDOG_TICKS`, writes the trace, and exits non-zero rather than hanging. Heterogeneous VC counts route correctly across a 3-router chain. A link with `depth < RT₀` saturates at `depth/RT₀` **with an empty network** (proves the static validator's premise); the same link with `depth ≥ RT₀` hits 100%. `credStall` is attributable — undersized-buffer and congested cases are distinguishable from the metrics alone. |
| 4d | `scheduler.pending()` does not grow during multi-hop transit — decision 6, executable. |
| 4e | Both demos build and run; `git diff` of the regenerated `.cpp` reviewed by hand (the repo is under git as of the initial commit, so the cutover's codegen change is reviewable rather than invisible); latency-model migration banner appears in a project with a hand-written model. |
| 5 | **Determinism is load-bearing now: run the same design twice, assert byte-identical traces** — this is what makes replay sound. **Observation does not perturb:** a run with per-VC recording on produces identical tier-A aggregates to one without. Replaying `[1k, 2k]` with per-VC recording reproduces the stored per-port aggregates for that interval exactly (proves the regenerated view and the permanent record agree). `tokenAnim` output unchanged for an unchanged design. The flit ring respects `ringRecords` and emits `truncated`. Expand-a-port round-trip completes in ≲10 ms on the reference workload. |
| 6 | Every new class has a rule in `styles.css`; render both hosts and diff visually. Zero new `HostMsg`/`ViewMsg` variants — assert by grepping `messaging.ts` unchanged. |
| all | **Constants audit.** Every numeric literal introduced outside `packages/contracts/src/noc.ts` is either a derivation or a test fixture — grep for bare numbers in new model/engine config paths. Migrating a project with no authored bandwidths, and one with no frequency, each produce an `assumedValue` diagnostic that names the field and the reason. |

**End-to-end, the thing that proves the whole change:** build a 2×2 mesh from the
topology picker, assign a CPU tile at 2 GHz and a USB tile at 60 MHz to different
clock domains, define two regions targeting two banks *of the same memory tile*
by `iface`, run in accurate mode, and confirm: both banks receive their own
traffic (impossible today), the CDC latency shows up in the trace, and raising
offered load produces a latency knee with `credStall` rising — which is the whole
reason for the redesign.

---

## Deferred beyond v1

| Deferred | Why, and what would trigger it |
|---|---|
| **Restorable snapshots** | Replay-from-zero reaches any point in a 100k-cycle run in ~1.6 ms and the whole run in ~100 ms, so a restore point saves milliseconds. Snapshots start paying past roughly **10M cycles** (~200 ms of replay). The interface — "give me full detail for this window" — is unchanged when they arrive, so this is an optimization, not a rewrite. **The blocking hazard is not the router: it is hand-written block state.** Parser rule V1 sees only `<type> <name> [= init];` at class depth 1, so a `std::vector`, a nested struct, or a static below the END marker is invisible to the model; a snapshot built from the model would omit it and the restore would **diverge rather than fail**. Any snapshot work starts by deciding how blocks declare serialisable state. |
| **Global filtered queries** | Questions of the form *"every flit that ever waited > 20 cycles, across the whole run"* are not served by windowed replay, and the full-detail trace they would need is the 132 MB we set out to avoid. The right mechanism is an engine-side **filtered pass** over the whole run emitting only matches — a third query mode alongside aggregates and replay, not a variant of either. |
| **Per-VC metrics as stored series** | Deliberate, not pending: 1,280 series against tier A's 480, to answer a question most runs never ask. Regenerated in ~2 ms on expand. Revisit only if replay latency stops feeling instant. |
| **Tile-class inference** | A name heuristic (`Memory*` → `mem`) does not belong in production migration code. `robot_soc` and `sample` are repo-owned fixtures and get hand-edited. |
| **Software-driven simulation** | Pre-existing deferral, unchanged by this plan: a real ISS core / Spike / QEMU adapter driving traffic instead of the traffic generators. The NI is the natural attachment point when it happens. |

## Questions this design has already been asked

Recorded so they are not re-litigated. Each was raised during planning and the
answer is non-obvious.

| Question | Answer |
|---|---|
| **"To see detail at cycle 95,000, don't you have to store everything up to it?"** | No — **replay runs with recording off until it reaches the window.** The seek emits nothing; only the requested window produces data. `storage = O(window)`, `time = O(position)`. The volume problem was always level **×** duration: per-flit detail is 132 MB over 100k cycles and **1.4 MB over 1k cycles**. |
| "Shouldn't the router act on `tick()` rather than `handler()`?" | Yes. `handler()` did route lookup at arrival (one stage early, off the clock); Dispatch runs before Tick so a packet entered and left in one cycle; and calendar insertion order leaked sender scheduling order into router behaviour. The NoC becomes synchronous; `handler()` stays exactly right for IP-stage blocks. |
| "Why are VCs a property of the router, not the link?" | VC allocation is already per-hop — the head flit at R1 allocates one of **R2's** input VCs — so the count naturally belongs to the receiving router, and upstream credit tables size themselves from what downstream declares. Heterogeneous counts need no codegen awareness. |
| "Isn't `depth ≥ RT₀` enough for throughput?" | Only at zero load. `RT = RT₀ + queueing`, and under congestion it grows without bound — correctly, that is backpressure working. The validator catches *self-inflicted* throughput loss present on an idle link; congestion is measured (`credStall` paired with downstream `vcOcc`), never validated. |
| "Is this just storing less data?" | It is storing **different** data — answers rather than evidence. `vcOcc`, `credStall` and `hol` have no event-level footprint at any granularity; they are wanted even with unlimited storage. Only `flow`, `bits` and `qdepth` could be re-derived from raw events. |
| "Is a packet the same as an `Event` between pipeline stages?" | No. A packet is an `Event` **in transit across the NoC** — a role, not a different object. An `Event` between blocks inside one tile is never a packet. Same object end to end; the tail flit carries it. |
