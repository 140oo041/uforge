---
target: the canvas surface (ide/src/webview)
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-07-26T18-59-39Z
slug: ide-src-webview
---
Method: dual-agent (A: a61dc3f6c3ddb4098 · B: aa242d3c756e0f216)
Target: `ide/src/webview/` — the VS Code webview canvas surface · Mode: **Operate**
Browser visualization: **skipped** — no browser automation exposed in this session (no Playwright, no Puppeteer, no Chrome/Chromium binary). No overlay exists and none is claimed. Assessment B substituted mechanical source evidence.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Run is fire-and-forget — `shell.tsx:67` never disables or relabels; a Verilator failure posts only a console line and a `✗` chip into a tab that isn't selected, in a panel that may be collapsed. |
| 2 | Match System / Real World | 4 | Domain vocabulary is exceptional. One lapse: `⛔ wire not allowed` (`canvas.tsx:801`) where PRODUCT.md promises `⛔ needs router` — forbids without instructing. |
| 3 | User Control and Freedom | 1 | Backspace on a composite unlinks every descendant `.cpp` from disk (`writer/index.ts:195-200`), with no confirmation, and undo restores one empty composite. |
| 4 | Consistency and Standards | 2 | Two orchids for one documented meaning (30 drift-palette occurrences); two inspector class systems (`insp-` vs `ins-`/`isa-`); `<a>` with no `href` for every source link; five feature classes with no CSS at all. |
| 5 | Error Prevention | 2 | Cross-top wires are blocked at three layers and address ranges are BigInt-guarded — but zero confirmation on any destructive act, and Escape inside a popover `<select>` drills the canvas out instead of cancelling. |
| 6 | Recognition Rather Than Recall | 2 | The connect popover lists raw dot-path ids while the canvas shows labels (`canvas.tsx:1391-1409`); METRICS path pickers are unsearchable id lists; the three meanings of a port drag live only in `title` tooltips. |
| 7 | Flexibility and Efficiency | 2 | Rich pointer shortcuts (space-pan, right-drag, ctrl-wheel, V/H, F2) — but no Run/Verify shortcut, no multi-select editing (`inspector.tsx:756` gates on `size === 1`), and `Ctrl+V` silently switches the active tool (`app.tsx:537`). |
| 8 | Aesthetic and Minimalist Design | 2 | The at-rest canvas and inspector are genuinely disciplined; undermined by an unstyled native button parked in the canvas corner, an unstyled METRICS tab, dead `.status*` rules, and CRM-style avatars. |
| 9 | Error Recovery | 2 | The undelivered-hops message (`bottom-panel.tsx:390-402`) is best-in-class — cause, consequence, two named fixes. But it lives in a tab you must find; toasts self-destruct in 4.2s with no history; compile failures produce no toast at all. |
| 10 | Help and Documentation | 2 | `title` attributes are dense and often excellent, and `palette.tsx:106-110` teaches the core gesture — but tooltips are mouse-only, there is no empty-canvas first-run state, and the router/rule model is never explained *before* it blocks you. |
| **Total** | | **21/40** | **Acceptable — significant improvements needed** |

All ten heuristics apply; this is an Operate surface with real tasks, real errors, and real docs surface area. Nothing was scored `n/a`.

## Design Specificity Verdict

**Strongly product-specific at the canvas layer, conventional at the chrome layer — and the single most product-specific runtime feature ships with no stylesheet at all.**

### LLM assessment

What could not be lifted into another dev tool:

- **The polymorphic port drag** (`canvas.tsx:400-435`). One gesture means four different structural acts depending on its endpoints: leaf→leaf inside a composite is a wire; anything touching a router is a fabric attachment; router→router is a trunk; top-level→top-level at root opens `RuleForm` instead of `ConnectForm`. The hardest rule in the product — cross-top wires are design errors, not shortcuts — is taught by converting the illegal gesture into the legal authoring act rather than rejecting it. This is the surface's best idea.
- **Status→geometry coupling.** `LinkStatus` drives the dash pattern (`styles.css:290-293`), and `worst()` (`layout.ts:158-161`) makes an aggregated composite edge inherit the worst status of its members. Drilling out can never make a design look healthier than it is.
- **Node height as a pure function of interface** (`layout.ts:42-51`): `NODE_HEADER + portRows·20 + varRows·16`. A block's silhouette is literally its port count.
- **In-port rows keyed by consumed event** (`layout.ts:27-30`), so the same event name appears at both ends of a wire and the diagram reads as a message contract, not a box-and-arrow drawing.

What is interchangeable furniture:

- **`.insp-avatar`** (`inspector.tsx:1057`) renders `component.charAt(0).toUpperCase()` in a 20px rounded square. That is a CRM contacts idiom on a hardware component — and an honest glyph vocabulary (▣ ◈ ⇄ ⚡) already sits unused two lines away.
- **The 26×15 sliding pill toggle** (`styles.css:1333-1357`) for fabric attachment and divergence checking. Inside VS Code the native idiom is a checkbox; this is a mobile-settings component wearing a webview.
- **The METRICS tab** (`bottom-panel.tsx:82-182`): three columns of tables plus a bar chart, generic analytics layout — and it has no stylesheet.

**Does "the honest living schematic" actually read?** The honesty half reads in the wires and not in the numbers: the Dash Rule is implemented for every connection class, but nothing marks the epistemic status of a *number*. A router hop latency the architect typed and a queue depth the engine measured render identically as 16px mono in adjacent tiles (`inspector.tsx:939-989`). For a product whose whole claim is "from a run that actually happened," the measurement/assertion distinction is invisible exactly where it matters most.

The liveness half is partially real and its flagship is dark. Token motion is genuine and deterministic — `tokenPositionAt` is a pure function of `(hops, playhead)` (`tokenAnim.ts:52-75`), so scrubbing backward is exact. But the metrics overlay has no CSS whatsoever (see P1 below).

### Deterministic scan

`detect.mjs` over `ide/src/webview` + `ide/preview/preview.html`: **exit 2, 1 finding**. A second labeled run against `styles.css` alone returned the identical single finding and no additional rules. No finding in any `.tsx` file or in `preview.html`.

- `codex-grid-background` (advisory, slop) at `styles.css:272` — **false positive, confirmed**. Three reasons: the rule targets "hairline linear-gradient layers" and this is a single `radial-gradient` dot field; the rule text explicitly exempts "actual canvas … or measurement surfaces" and the selector is literally `.canvas`, the pannable/zoomable schematic viewport; and the 24px cell is load-bearing, sitting at exactly 3× the documented 8px `GRID` snap.

**Net detector result: 1 raw finding, 0 real.** The mechanical slop detector is clean on this surface — which is worth saying plainly, because the real defects below are all things a generic detector cannot see.

Assessment B's static conformance pass against DESIGN.md's own named rules found what the detector could not:

| Rule | Violations | Where |
|---|---|---|
| Canonical Fallback | **30** occurrences / 26 lines | `styles.css`, 28 of 30 concentrated at `:1038-1425` (the inspector-v2 block) |
| Theme-Parasite | **51** occurrences | `styles.css` throughout; the 8-colour token ramp in `.tsx` is correctly exempt |
| Earned Shadow | **2** extra roles | `styles.css:931` (inset playhead), `styles.css:294` (second drop-shadow) |
| Radius >8px on a surface | **2** | `styles.css:682`, `:702` — both `9px` |
| Type size >16px | **2** | `styles.css:242` (18px palette glyph), `:52` (17px activity glyph) |
| Shrinkable Child | **2** genuine of 11 candidates | `styles.css:748`, `:1117` |
| Motion | **0** | Every transition is 0.15s; all three keyframes are 0.9–1.1s and state-gated |

Two of these deserve calling out because they are the detector catching what the design review missed:

- **`.spec-chip-input` at `styles.css:702`** uses `border-radius: 9px` where DESIGN.md specifies "a 1px *dashed* border at **pill radius**." The dashed border is correct; the radius is off by 990px. The rule's intent — a field that doesn't exist yet — survives, but the shape doesn't.
- **`.pipe-grid .playhead` at `styles.css:931`** is the only `inset` box-shadow in the system: a fourth shadow role that isn't a lift, a detachment, or a selection. And `styles.css:294`'s `drop-shadow(0 0 3px currentColor)` on selected wires is a second luminous effect, which DESIGN.md both specifies (`:561`) and forbids (`:407-408`, "the only luminous effect in the system"). That is a genuine contradiction inside the design document, not just in the code.

One more the review missed: **a third purple**. `#6e5be822` appears at `styles.css:1103`, `:1220`, `:1424` — neither canonical orchid nor in the documented drift set.

### Visual overlays

None. Browser injection was not attempted because no browser automation exists in this session; the fallback signal is Assessment B's static evidence above. Separately, `ide/preview/preview.html:70-72` still carries a stale injected block pointing at `http://localhost:8400/live.js` whose server is dead (port not listening, no process). The built bundle it loads is current — `media/webview.js` is 16 seconds newer than the newest source — so the preview *would* reflect current source once that dead script tag is removed.

## Overall Impression

The schematic layer of this tool is genuinely good, and in two or three places it is better than good — the port drag, `worst()` status aggregation, and the undelivered-hops error message are the work of someone who understood the problem. The shell around it is competent VS Code mimicry, which is the right call for Operate.

What's wrong is a consistent pattern, and it's the same pattern three times: **the product's stated principles are implemented in the geometry and abandoned at the edges.** "Never hide a failure" is load-bearing in the wire dash grammar and absent when Verilator fails silently. "Show what actually happened" produced a real trace engine and a metrics overlay with no CSS. "The code is the design" built a byte-preserving writer and then wired Backspace to delete the user's hand-written C++ with no confirmation and no working undo.

The single biggest opportunity is not a new feature. It is finishing the ones that already exist: style the metrics overlay, give Run a state, and make the destructive path safe. Those three close the gap between what DESIGN.md claims and what the surface does.

## What's Working

1. **The port drag is the product's thesis expressed as a gesture** (`canvas.tsx:400-435`). Four structural meanings from one motion, disambiguated by endpoint kind, with the illegal case rerouted into the correct authoring form rather than rejected. It works because the architect never has to learn a mode — the geometry already knows what the drag can legally mean, so the tool answers with the right form instead of an error. Refusing would have been correct-but-hostile; converting is correct-and-generous.

2. **Status is load-bearing all the way down, including under aggregation.** `worst()` (`layout.ts:158-161`) means a composite collapsed at a drill level inherits the worst status of the links inside it. Combined with the dash grammar and `StatusChip` (`inspector.tsx:103-110`), the same four-state vocabulary reads identically on a wire, on a rolled-up composite edge, and in a summary count. This is why "never hide a failure" survives zooming out — most tools lose the bad news exactly at the altitude where the architect is looking. It is also the system's best accessibility decision, because dash pattern is a second channel alongside colour.

3. **The undelivered-hops warning is model error copy** (`bottom-panel.tsx:390-402`). It states the count, the mechanism ("the clock stopped at cycle N while arrivals extend to M"), the consequence ("wire-flight only, no handlers ran"), two named fixes with the exact control to use ("raise **cycles** in the run config (⚙▾ next to Run) or shorten the wire latencies"), and the three worst offending links — and it is click-to-scrub. Every other error message in this app should be measured against this one.

## Priority Issues

### [P0] Backspace irreversibly deletes a composite's entire subtree, source files included

`app.tsx:523-525` binds both `Delete` and `Backspace` to `deleteSelection()`. That emits `removeComponent`, the reducer expands it to the whole descendant set (`writer/edits.ts:185-188`), and the writer `fs.unlinkSync`s every generated `.cpp` no longer live (`writer/index.ts:195-200`) — including the architect's hand-written `handle()` bodies outside the marker regions. The undo entry re-adds **one** component and its own out-ports; children, their wires, their layout and their source are gone. No confirmation exists anywhere in the surface.

**Why it matters:** the architect is deadline-pressed and mid-exploration. One stray Backspace with a `CPU0` composite selected destroys hours of C++ and Ctrl+Z hands back an empty box. It also directly contradicts "the code is the design" — the canvas is deleting source the canvas cannot restore.

**Fix:** unbind `Backspace` and keep `Delete`. When the selection contains a composite with children, confirm with the count and the consequence ("Delete CPU0 and 6 blocks inside it? 6 .cpp files will be removed."). Make the undo entry snapshot the full subtree — components, layout entries, links, and the file text the host is about to unlink — and replay it; or have the host move unlinked files to a session trash and restore from there.

**Suggested command:** `/impeccable harden`

### [P0] There is no keyboard path to the canvas at all

`canvas.tsx:892-896` renders nodes as `<article>` with only pointer handlers; port dots are `<span onPointerDown>` (`:1157-1161`, `:1183-1189`); wires are SVG `<path>` (`:743-762`). Assessment B confirms the scale mechanically: the entire webview contains **zero** `tabIndex`, **zero** ARIA `role` attributes, and **four** `aria-*` attributes in total, all in `inspector.tsx`. Nine non-semantic elements carry `onClick` with no role, tabindex, or key handler. Every `<a className="message-link">` — the product's core drill-down affordance, at seven call sites across `canvas.tsx` and `inspector.tsx` — has no `href`, so it is unreachable by keyboard and announced as plain text.

**Why it matters:** a keyboard or screen-reader user cannot complete step 2 of the primary action. Not "with difficulty" — at all. Selecting, moving, drilling into, wiring, or deleting anything on the canvas is pointer-exclusive.

**Fix:** roving tabindex over visible nodes with `role="button"`; arrow keys to move (positions already snap to `GRID`); `Enter` to drill in, `F2` to rename (the handler exists). `tabIndex={0}` on `.wire-hit` with `Enter` to select and `Delete` to remove. A keyboard connect path: focus a port row, `Enter` opens `ConnectForm` with an added `to` select when there is no drop target. Convert every `message-link` to a `<button>`. Add `aria-pressed` to `.toolbar button.on`, `.impl-toggle` and `.insp-seg`, and `role="tab"`/`aria-selected` to `.editor-tab` and `.panel-tabs` — none of which currently expose their state non-visually.

**Suggested command:** `/impeccable audit`

### [P1] The metrics overlay — the feature that answers "where did it stall" — has no stylesheet

Verified by full class diff against `styles.css`: `.metrics-toggle` (`canvas.tsx:1305-1313`), `heat-${n}` on nodes (`:894`), `wire-heat-${heat}` (`:741`), `.wire-bw` (`:768-777`), `.depth-chip` (`:944-951`), and `.metrics-tab/-col/-table/-path/-hist`, `.hist-n`, `.hist-lo` (`bottom-panel.tsx:82-182`) have **no rules at all**. The toggle renders as a native UA button in the canvas' top-left corner — violating the No-Overlay Rule by accident. Node and wire heat classes do nothing. The `pkt/cy` bandwidth label and the entire latency histogram render in SVG-default black on `#1e1e1e`: **1.26:1**, invisible.

**Why it matters:** this is the product's third principle ("show what actually happened") reduced to a toggle that appears to do nothing. The architect concludes the design has no contention. It is also the most product-specific runtime feature in the tool, so it is exactly the wrong thing to have shipped unstyled.

**Fix:** `.metrics-toggle` positioned bottom-left reusing the `.toolbar button` / `.on` idiom; `.node.heat-1/2/3` as graded box-shadow rings stepping toward coral; `.wire-heat-1/2/3` as opacity steps (stroke width is already inline); `.wire-bw` with the Halo Rule (`paint-order: stroke`, 3px stroke in the editor background); `.metrics-hist rect` in charts-blue; `.metrics-table` with hairline rows, `tabular-nums`, `cursor: pointer` and a hover wash.

**Suggested command:** `/impeccable polish`

### [P1] Run is fire-and-forget, and a build failure is the quietest event in the app

`shell.tsx:67-70`: the Run button has no pending, disabled, or progress state; `app.tsx:595` posts `simulate` and returns. `extension.ts:397` sets `phase:'building'`; the catch at `:474-480` posts a log line and `phase:'error'` — no `editError`, so no toast, no panel expand, no tab switch. The panel's tab defaults to `'console'` (`bottom-panel.tsx:191`) and is never reset, so after a successful run the first thing shown is raw `make` output rather than TRACE or PROBLEMS.

Compounding it: DESIGN.md reserves Instrument Yellow for "the building/running phase," and that rule exists only in `.status-building` (`styles.css:217`) — **dead CSS**. The live phase chip `.sb-phase.sb-building` (`:164`) is a neutral `#ffffff22` wash. With Verilator in the loop this is tens of seconds of no signal.

**Why it matters:** the two moments the architect is most anxious — waiting on a build, and finding out it failed — have the least feedback in the entire surface. A second click starts a second build. Meanwhile the *preventable* cross-top-wire error does get a toast, so the rarer, more recoverable failure gets the louder treatment.

**Fix:** drive the Run button from `runStatus.phase` — label "Building…" / "Running…", disable with `opacity: .4; cursor: default` (never a colour change, per the system's own rule). On `phase:'error'`, auto-expand the panel and select CONSOLE; on `phase:'done'` with `problemCount > 0`, select PROBLEMS. Emit an `editError` on the catch branch. Give the phase chip Instrument Yellow while building, as DESIGN.md already specifies and only dead CSS implements.

**Suggested command:** `/impeccable harden`

### [P1] The light-theme claim is false, and secondary text fails contrast on the dark default

DESIGN.md states the surface "inherits the user's light or dark theme." Assessment B counted **51 raw hex values with no `--vscode-*` variable behind them**, all in `styles.css` — including every icon-button hover, every badge, the occupancy chip, the status-bar phase wash, the card body divider, and the toggle's off track. On a light theme all of them disappear.

The **30 Canonical Fallback drift occurrences** compound it, and one is functional rather than cosmetic: `.wire-fabric` uses `var(--vscode-charts-purple, #b180d7)` (`:1056`) while `.wire-routed` and `.wire-derived` use bare `#a99df2` (`:1397`, `:1398`, `:1403`, `:1410`). Inside a themed VS Code these become **two different colours carrying one documented meaning** — the One Meaning Rule and the Theme-Parasite Rule break together, visibly, on the interconnect. DESIGN.md's claim that the drift "collapses to the same value inside a real theme" is therefore only true for the values that actually have a variable; for these five it is false.

Measured on the dark default: `.var-type` compounds `0.65 × 0.75` to **3.29:1** at 10px; `.port-row-empty` **3.02:1**; `.console-line.dim` **3.62:1**; `.enc-bits` **3.52:1**; `.node-id` **3.78:1**; `.occupancy-chip.hot` white-on-coral **3.49:1** at 9px; activity-bar inactive **3.42:1**; and `.wire-fabric` orchid at `opacity: .55` is **2.60:1** — below even the 3:1 non-text threshold, for the lines carrying the interconnect.

**Fix:** replace every bare white wash with `var(--vscode-toolbar-hoverBackground, #ffffff14)` or a host-token equivalent. Reconcile all four orchids to `var(--vscode-charts-purple, #b180d7)` so fabric, routed and derived stay one hue in any theme. `.insp-fn` → `var(--vscode-charts-orange, #ffb74d)`. Never nest a second `opacity` inside an already-dimmed parent (`.var-type`); lift `.dim` from 0.5 to 0.62 and `.port-row-empty` from 0.45 to 0.62.

**Suggested command:** `/impeccable colorize`

### [P2] Escape inside a popover drills the canvas out instead of cancelling

`app.tsx:512-514` exempts only `INPUT` and `TEXTAREA` from the global key handler. A `<select>` is neither — so Escape while focused on the connect popover's message select (`canvas.tsx:1414`) or the rule popover's router select (`:1539`) fires the global Escape branch, drilling the canvas out one level and clearing the selection **while the popover stays open**, now anchored to a node that is no longer on screen.

**Fix:** put an Escape `onKeyDown` on `.connect-form` itself with `stopPropagation`, and give the global handler a "close the topmost transient first" ordering: connect draft → rule draft → field card → run config → drill out.

**Suggested command:** `/impeccable harden`

## Persona Red Flags

**Alex (impatient power user)** — walking *open → wire two blocks → Run → find the stall*:

- **Wiring costs a mandatory popover.** Dragging from ＋ opens `ConnectForm` with up to five fields. `Enter` commits only from the `name` input (`canvas.tsx:1433`) — the moment he picks an existing event from the message select, that input unmounts and **Enter does nothing anywhere in the form**. Confirming requires a mouse trip to a 240px popover.
- **Run has no state.** He clicks, nothing changes, he clicks again — two concurrent builds.
- **He lands on the wrong tab after a run.** The panel is still on CONSOLE, so his first sight of results is raw `make` output.
- **The overlay he reaches for is invisible.** `▦ metrics` is an unstyled native button that appears to do nothing.
- **Playback is slower than his patience.** The clock advances `2.5 × speed` cycles/second (`app.tsx:188`) and the speed select caps at 4× — a 4,000-cycle trace takes 400 seconds at maximum.
- **`Ctrl+V` silently switches his tool** to select (`app.tsx:537` — the `else if` chain never checks `ctrlKey`).

**Sam (keyboard + screen reader + contrast)**:

- **Blocked at step 1 and step 2.** Nodes are `<article>` with no tabindex or role; port dots are `<span onPointerDown>`. He cannot select, move, drill into, wire, or open a block's source. Double-click is the only route to the `.cpp`.
- **Every source link is inert to him** — `<a className="message-link">` with no `href`, seven call sites.
- **State is announced nowhere.** No `aria-pressed` on toggled tools; no `role="tab"`/`aria-selected` on editor tabs, panel tabs, or the activity bar. A screen reader reads "▦ Design button, ⚙ SPEC button" with no indication which is open.
- **Focus indicators are correct where they exist.** Both `outline: none` declarations have a replacement (`styles.css:1134` substitutes a focus-blue border; `:1265` is covered by `.insp-tile:focus-within` at `:1237`), and the custom toggle keeps a real checkbox driving `:focus-visible` (`:1358-1361`). The problem is not bad focus styling — it is that canvas nodes and wires are not focusable at all, so no focus style *can* exist for them.
- **Meaning by colour alone:** wired vs unwired in-port dots are `#4fc3f7` vs `#888` on identical 11px circles, with only a mouse-only `title` as a second channel. Node heat, `.occupancy-chip.hot` and the playhead inset are likewise colour-only. The wires escape this because dash pattern is a real second channel.
- **Motion:** all three infinite animations (`pulse`, `congest-pulse`, `dwell-pulse`) keep running under `prefers-reduced-motion: reduce`. The single media query at `styles.css:1363-1365` covers only the three 0.15s transitions. A diverged design leaves a coral ring pulsing indefinitely for a user who asked the OS for no motion.

**Mira (student learning architecture — PRODUCT.md's secondary audience)**:

- **Her first instinct is illegal and nothing warns her first.** She drags two leaves onto the empty root canvas and wires them. Flat designs are illegal, so `connect` (`app.tsx:324-330`) refuses *after* the gesture, with a 130-character red toast naming "a forwarding rule on a ◈ router" — a concept the palette never introduced. The toast vanishes in 4.2 seconds with no way to recall it.
- **There is no empty state.** With zero components the canvas renders a dot grid and nothing else; the fit-to-view effect early-returns. The only guidance is `palette-help` at the bottom of an 11-item scroll.
- **One gesture, four meanings, taught only by tooltip.**
- **The error tells her what is forbidden, not what to do.** `⛔ wire not allowed`, with the actual reason buried in an SVG `<title>`, and the documented actionable copy `⛔ needs router` never implemented.
- **The palette is a flat 11-item list** mixing structural containers, a traffic source, and behavioural stages with no grouping — she has no basis for choosing between "Block", "Stage", "Control", "Memory", "Buffer" and "Sink" on day one.

## Cognitive Load

**4 of 8 checks fail → critical band**, though two failures are intrinsic to the domain rather than design defects.

| Check | Verdict |
|---|---|
| Single focus | Pass (intrinsic) — four simultaneous surfaces is the native IDE contract. |
| Chunking ≤4/group | **Fail, extraneous** — `palette.tsx:19-30` is 11 undifferentiated cards spanning three genuinely different kinds of thing. |
| Visual grouping | Pass, except METRICS, which has no styles and renders as three unseparated default tables. |
| Visual hierarchy | **Fail, extraneous** — PROBLEMS, the tab carrying the answer, is last and visually identical to CONSOLE; only a parenthesised count distinguishes it. |
| One thing at a time | Pass. |
| Minimal choices ≤4 | **Fail, mostly intrinsic** — palette (13), panel tabs (up to 7), router Forwarding card (5 controls before Rules begins), METRICS path pickers (two unsearchable selects of every block in the trace). |
| Working memory | **Fail, extraneous** — ids vs labels diverge across surfaces, and `foldState` is a module-level Map keyed by *card id, not component* (`inspector.tsx:47-48`), so collapsing "Trunks" on R0 collapses it on R1. The panel silently remembers a choice made about a different object. |
| Progressive disclosure | Pass. |

A router genuinely does have five knobs; that load is legitimate and should not be designed away. Be ruthless only about the palette's flatness, PROBLEMS' invisibility, and the id/label split.

## Minor Observations

- **Dead CSS asserting a rule the app doesn't follow.** `.status`, `.status-done/-error/-building/-running`, `.run-group` (`styles.css:206-217`) are unused. DESIGN.md's "Instrument Yellow … the building/running phase" is true only in those dead rules.
- **A fourth shadow role and a second luminous effect.** `styles.css:931` is the only `inset` box-shadow in the system; `styles.css:294` adds `drop-shadow(0 0 3px currentColor)` on selected wires. DESIGN.md specifies the latter at `:561` and forbids it at `:407-408` — a contradiction in the document itself, which should be resolved in DESIGN.md before it is "fixed" in code.
- **Two `9px` radii** at `styles.css:682` and `:702`, above the 8px surface ceiling and off the 3/4/6/7/8 scale. `:702` is the spec chip-input, which DESIGN.md specifies at *pill* radius.
- **Two type sizes above 16px:** `styles.css:242` (18px palette glyph, undocumented) and `:52` (17px activity glyph). The second is DESIGN.md contradicting itself — `:533-534` specifies "17px glyphs" while `:636` says don't exceed 16px.
- **A third purple:** `#6e5be822` at `styles.css:1103`, `:1220`, `:1424` — neither canonical nor in the documented drift set.
- **Two genuine truncation failures** of 11 candidates: `.isa-summary` (`styles.css:748`, `flex: 1` with `min-width: auto` in force) and `.insp-title .name` (`:1117`, the inspector identity header that receives generated block names). The other nine are constrained by `max-width`, an explicit `min-width`, or a non-flex context.
- **`wire-fabric-attach` is generated** (`canvas.tsx:670`) but only `.wire-fabric-trunk` has a rule — attachments and trunks differ by 1px of stroke width and nothing else.
- **The toast is a single-slot channel for six distinct failure classes** with no queue, dismiss, or history (`app.tsx:80-83`). Two errors in quick succession and the first is lost.
- **`nodeAt()` returns the first array hit, not the topmost drawn node** (`canvas.tsx:369-378`). With overlapping nodes a wire drop resolves to whichever component the parser emitted first, not what the user sees on top.
- **`.tokens circle` applies the drop-shadow glow to every token** including dwelling ones (`styles.css:286`); DESIGN.md reserves it for in-flight bubbles alone.
- **`.node.congested` and `.node.diverged`** both set a coral border and an infinite pulse differing only in ring radius — two distinct conditions rendered nearly identically.
- **`ide/preview/preview.html:70-72` carries a stale live-injection block** pointing at a dead server on port 8400. The built bundle it loads is current.

## Questions to Consider

1. **Why is "where did it stall" an overlay you have to find?** The canvas already computes `congestedAt` and `linkBandwidthAt`. The stated atmosphere is "calm by default, loud on evidence" — but the evidence currently requires locating an unstyled button. What if a run that lands with contention *automatically* enters the heat state, and the toggle only ever turns it back off?

2. **Nothing marks the epistemic status of a number.** The Dash Rule tells you how true a *connection* is. A typed hop latency and a measured queue depth are typographically identical. What is the Dash Rule for the number layer — an entered-vs-measured distinction, a provenance mark, a well that reads recessed only when the value came from a run?

3. **Only one surface treats time as an axis.** The canvas shows one instant, TRACE shows one instant, WAVES shows time but only for SV blocks. The architect's actual question — "where does the fabric saturate" — is a question about a *duration*. Would a per-link occupancy-over-time strip under the canvas, sharing the playhead, answer it faster than scrubbing to find the worst instant by hand?

4. **Four meanings, one drag, and no live confirmation.** The draft wire is an unlabelled dashed path. If it named itself mid-drag — "wire" / "attach to R0" / "trunk" / "rule to Memory1" — would the whole class of "why did it do that" disappear without adding a pixel of permanent chrome?

5. **DESIGN.md contradicts itself in two places** (the wire drop-shadow, the 17px activity glyph) and asserts one thing that is measurably false (drift "collapses to the same value inside a real theme" — not for the five bare `#a99df2` strokes). If the document is the standard, which of those is the document being wrong, and which is the code having drifted?
