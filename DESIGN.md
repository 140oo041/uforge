---
name: ISS Microarchitecture IDE
description: A schematic that never lies about how true it is, and comes alive when you run it.
colors:
  signal-cyan: "#4fc3f7"
  fabric-orchid: "#b180d7"
  sage-green: "#89d185"
  sodium-amber: "#ffb74d"
  alarm-coral: "#ef5350"
  instrument-yellow: "#f9a825"
  action-blue: "#0e639c"
  focus-blue: "#007fd4"
  status-blue: "#007acc"
  editor-ground: "#1e1e1e"
  rail-surface: "#252526"
  widget-surface: "#2a2a2e"
  activity-surface: "#333333"
  field-surface: "#3c3c3c"
  hairline: "#3a3a41"
  ink: "#cccccc"
  ink-muted: "#9a9a9a"
typography:
  display:
    fontFamily: "var(--vscode-editor-font-family, ui-monospace, monospace)"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.1
    fontFeature: "tabular-nums"
  headline:
    fontFamily: "var(--vscode-font-family, system-ui, sans-serif)"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "var(--vscode-font-family, system-ui, sans-serif)"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "var(--vscode-font-family, system-ui, sans-serif)"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "var(--vscode-font-family, system-ui, sans-serif)"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.04em"
  micro:
    fontFamily: "var(--vscode-font-family, system-ui, sans-serif)"
    fontSize: "9px"
    fontWeight: 400
    letterSpacing: "0.08em"
  mono:
    fontFamily: "var(--vscode-editor-font-family, ui-monospace, monospace)"
    fontSize: "10.5px"
    fontWeight: 400
    fontFeature: "tabular-nums"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "7px"
  xl: "8px"
  io-pill: "18px"
  pill: "999px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  "2xl": "14px"
  "3xl": "18px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "4px 12px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "4px 12px"
    typography: "{typography.body}"
  button-secondary:
    backgroundColor: "#3a3d41"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "5px 10px"
    typography: "{typography.body}"
  button-toolbar:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
    typography: "{typography.body}"
  button-toolbar-on:
    backgroundColor: "{colors.action-blue}"
    textColor: "#ffffff"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "5px"
    height: "24px"
    width: "24px"
  input-field:
    backgroundColor: "{colors.field-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xs}"
    padding: "3px 6px"
    typography: "{typography.body}"
  input-field-focus:
    backgroundColor: "{colors.field-surface}"
    textColor: "{colors.ink}"
  chip-status:
    backgroundColor: "#ffffff12"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "1.5px 8px"
    typography: "{typography.micro}"
  chip-badge:
    backgroundColor: "#ffffff14"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "1px 7px"
    typography: "{typography.micro}"
  card-inspector:
    backgroundColor: "{colors.widget-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "4px 11px 10px"
  tile-stat:
    backgroundColor: "{colors.editor-ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "7px 9px 6px"
    typography: "{typography.display}"
  node-block:
    backgroundColor: "{colors.widget-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    width: "200px"
    padding: "7px 10px 4px"
  node-io:
    backgroundColor: "{colors.widget-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.io-pill}"
    width: "200px"
  popover:
    backgroundColor: "{colors.widget-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "10px"
---

# Design System: ISS Microarchitecture IDE

## Overview

**Creative North Star: "The Honest Living Schematic"**

Two invariants, held together. The first is **honesty**: this is a wiring diagram
that refuses to flatter itself. Every stroke on the canvas declares its own
epistemic status before it declares anything else — solid where real code
substantiates it, dashed where it was inferred, dotted where it is a stub, red
where it is broken, purple where a router's rules own the destination rather than
an authored wire. The diagram would rather look unfinished than look finished and
lie. The second is **liveness**: at rest the schematic is a static drawing, but the
moment you Run, it becomes the execution — tokens travel the real hop geometry,
blocks pulse where they diverged, queues visibly congest, waveforms scrub against
the same playhead. The drawing and the running machine are the same object.

The atmosphere is **quiet, precise, and alive under load**. At rest the surface is
near-silent: a 24px dot grid, hairline dividers, flat tonal layers stepping from
editor ground to sidebar rail to widget, chrome muted to 55–70% opacity, no
gradient and no ornament anywhere. It only raises its voice when something actually
happened — a token moves, a block diverges, a router saturates. Calm by default,
loud on evidence. Nothing pulses, glows, or colors itself for decoration; every
animation in the system is a report.

Components are **recessive until touched**. Buttons are transparent with no border
until hover. Inspector name fields look like text until you point at them, then
grow a border, then a filled field on focus. Composite quick-add pins are hidden
until the node is hovered or selected. Structure appears on demand and retreats
again, so density never becomes noise. The one exception is deliberate: the largest
type in the entire application is a **number** — the 16px monospace stat-tile value.
In a tool whose whole claim is that it ran for real, the measurement outranks every
heading.

The palette is not owned by this project. Every color rides a `--vscode-*` theme
variable with a literal fallback, so the surface inherits the user's light or dark
theme and reads as part of the editor rather than as an app embedded inside one.
The fallbacks exist for the standalone browser preview; the variable is always the
normative source.

**Key Characteristics:**

- Line style is semantic: dash pattern encodes how true a connection is.
- Motion only ever reports state — never decorates.
- Theme-parasitic color: `var(--vscode-*, fallback)` on every single value.
- Recessive chrome, expressive canvas; brand lives in the schematic, not the shell.
- Tonal layering and hairlines over shadow; three earned elevations only.
- Monospace for anything that is an identifier in real code.
- The biggest type on screen is a measured number.

## Colors

Six semantic hues, each carrying one fixed meaning across canvas, inspector and
panel, over a five-step neutral ladder inherited from the host theme. Hue is never
chosen for variety — a color appearing anywhere is a claim about state.

### Primary

- **Signal Cyan** (`#4fc3f7`, `--vscode-charts-blue`): the authored, the real, the
  interactive. Solid wires that exist as `configureOut` in code, wired port dots,
  message links, pipeline bars, the primary token color, inspector block glyphs.
  If something is cyan, the code substantiates it.
- **Action Blue** (`#0e639c`, `--vscode-button-background`): committed action only —
  Run, Confirm, Add, the ＋ new-port handle, active toolbar tool, segmented-control
  selection. Never used to convey data state.
- **Focus Blue** (`#007fd4`, `--vscode-focusBorder`): focus and intent — selection
  rings, marquee stroke, draft wire being dragged, popover borders, hovered palette
  item, field focus. The color of "you are about to."

### Secondary

- **Fabric Orchid** (`#b180d7`, `--vscode-charts-purple`): the interconnect and the
  hierarchy — composite node borders and their gradient wash, router node borders
  and 12% fill, fabric attachment and trunk wires, `⇢ via R0 → R1` route badges,
  rule-derived ghost edges, forwarding-rule numbers. Orchid means "a router's rules
  own this, not an authored wire."
- **Sage Green** (`#89d185`, `--vscode-charts-green`): the confirmed boundary —
  I/O pin nodes and their pill silhouette, composite boundary pin rows, the ▶
  simulation-entry badge, SV bit-lane waveform edges, the `wired` status dot.

### Tertiary

- **Sodium Amber** (`#ffb74d`, `--vscode-charts-orange`): the provisional and the
  hand-owned — dangling stubs and their reason, the SV twin chip, hand-written
  block badges, traffic-generator glyphs, console warnings, latency-model function
  names, the waveform cursor. Amber is not an error; it is "authored by you, or not
  yet resolved by the parser."
- **Instrument Yellow** (`#f9a825`, `--vscode-charts-yellow`): reserved for the
  playhead and the building/running phase. Time, and only time.

### Neutral

- **Editor Ground** (`#1e1e1e`, `--vscode-editor-background`): the canvas floor and
  stat-tile wells — the deepest surface. Also the halo stroke that lifts wire labels
  off the wires beneath them.
- **Rail Surface** (`#252526`, `--vscode-sideBar-background`): palette, inspector,
  spec sections — the flanking rails.
- **Widget Surface** (`#2a2a2e`, `--vscode-editorWidget-background`): everything
  that lifts — nodes, popovers, inspector cards, field cards.
- **Activity Surface** (`#333333`, `--vscode-activityBar-background`): the outermost
  rail.
- **Field Surface** (`#3c3c3c`, `--vscode-input-background`): inputs and selects.
- **Hairline** (`#3a3a41`, `--vscode-panel-border`): every divider, every card edge,
  every grid line. The primary structural device of the whole system.
- **Ink** (`#cccccc`, `--vscode-foreground`) and **Ink Muted** (`#9a9a9a`,
  `--vscode-descriptionForeground`): body text and secondary text. Most secondary
  text is achieved by opacity (0.55–0.8) rather than a second color.

### Failure

- **Alarm Coral** (`#ef5350`, `--vscode-charts-red`): unresolved links, diverged
  blocks, congested routers, `⛔ needs router` fabric errors, hot occupancy chips,
  console divergences, destructive actions. This is the only hue permitted to
  animate indefinitely.

### Token Categorical Ramp

Eight fixed colors, assigned by token index and shared verbatim between the canvas
bubbles and the pipeline grid so a token keeps its identity across surfaces:
`#4fc3f7` `#ffb74d` `#aed581` `#f06292` `#ba68c8` `#4db6ac` `#fff176` `#a1887f`.
Pipeline cell backgrounds derive instead from a hash of the block id at
`hsl(H 45% 28% / 0.85)`, so a block keeps one color across every run.

### Named Rules

**The Theme-Parasite Rule.** Every color is written as `var(--vscode-TOKEN,
fallback)`. The variable is normative; the literal exists only so the standalone
browser preview stays usable. A raw hex with no variable behind it is a defect
unless the value has no host equivalent (the token ramp, the pipeline hash).

**The One Meaning Rule.** A hue means exactly one thing system-wide. Cyan is never
decorative, amber is never an error, orchid is never a highlight. Before adding a
color, find the existing hue whose meaning already covers the case; if none does,
the case probably isn't a new color.

**The Canonical Fallback Rule.** One literal per semantic hue, listed above. The
inspector-v2 rewrite introduced a parallel set (`#3794ff` / `#4aa3ff` for cyan,
`#f14c4c` for coral, `#71c98d` for sage, `#a99df2` for orchid, `#d18616` for amber,
`#e0b34a` for the brass function-name variant). Those are **drift, not vocabulary** —
inside a real VS Code theme they collapse to the same value, so they are invisible
in the host and only diverge in the browser preview. New code uses the canonical
value; touched code reconciles to it.

## Typography

**UI Font:** the host's `--vscode-font-family` (fallback `system-ui, sans-serif`)
**Mono Font:** the host's `--vscode-editor-font-family` (fallback `monospace`)

**Character:** Two families, one rule between them. The UI font carries everything
the interface says; the mono font carries everything that is literally an
identifier in the user's code. There is no third family and no display face — the
personality comes from the discipline of that split, not from a typeface choice.
Numbers that a user compares column-to-column always take `tabular-nums`.

### Hierarchy

- **Display** (600, 16px, mono, tabular): stat-tile values only — router latency,
  queue depth, weights, bandwidth. The largest type in the application, and it is
  always a measured or entered number.
- **Headline** (600, 15px): the SPEC tab's section title. Used once per tab.
- **Title** (600, 13px): inspector identity header and panel headings.
- **Body** (400, 12.5px, line-height 1.45): the base size — node labels (600),
  toolbar buttons, inspector rows, palette items, form labels.
- **Label** (600, 11px, uppercase, 0.04em): collapsible card summaries, section
  headings (`h4`, at 0.65 opacity), panel tabs.
- **Micro** (400, 9–10.5px, uppercase, 0.08em where labelled): stat-tile captions,
  encoding-strip field names, badges, chips, port names, wire labels. This is where
  most of the interface actually lives.
- **Mono** (400, 10.5px, tabular): state-variable names, ISA mnemonics, hex
  addresses, semantics blocks, waveform values, route paths, latency-model function
  names, pipeline token column.

### Named Rules

**The Identifier Rule.** If the string exists verbatim in the user's C++, SystemVerilog
or spec JSON — a member name, a class, a mnemonic, an address, a function — it is
set in mono. If it is the interface talking about that code, it is set in the UI
font. Never mix within one token.

**The Truncation Rule.** Every text container that can receive a generated name
carries `min-width: 0` plus `white-space: nowrap; overflow: hidden; text-overflow:
ellipsis`. Long generated identifiers (`out_Stage1_to_Stage2 · Stage1ToStage2Event`)
must truncate with an ellipsis — never wrap, never spill, never reflow a node.
Where truncation loses information, the full string goes in a `title` attribute.

**The Quiet Secondary Rule.** Secondary text is dimmed with opacity (0.5 for inert,
0.55–0.65 for keys and captions, 0.7–0.8 for supporting values), not with a second
ink color. This keeps every level of the hierarchy correct in any host theme.

## Layout

**The shell is one CSS Grid, and nothing floats over it.** Four named areas —
`activity` (44px) · `palette` (200px) · `editor` (1fr) · `inspector` (250px) — over
four rows: tab bar (35px), body (1fr), bottom panel (190px, collapsing to 26px),
status bar (22px). The SPEC tab reflows to a two-column variant where the editor
takes the full width. There are no absolute-positioned chrome overlays on the
canvas; the only absolutely positioned elements are genuinely transient (connect
popover, run-config popover, field card, toast, zoom badge, marquee).

**Spacing rhythm** is an 8px base with tighter half-steps for dense rows: 2 / 4 / 6
/ 8 / 10 / 12 / 14 / 18px. Canvas node positions snap to an **8px grid** (`GRID`),
matching the same rhythm. Node width is a fixed 200px — the same as the palette
column — with a 34px header, 20px port rows and 16px variable rows, so node height
is a pure function of port and variable count. Auto-layout separates columns by
110px and rows by 40px.

**Density is deliberate.** Interactive rows run 20–26px tall; buttons are 3–5px of
vertical padding. Cards get 10–12px of internal padding, popovers 10–12px, the
SPEC tab 16/20px. The canvas itself is a 24px radial dot grid on the editor ground,
which is the only patterned surface in the system.

**Responsive behavior is internal, not viewport-driven.** There are no media
breakpoints for width; the shell is a fixed-track grid inside a panel the user
resizes. Adaptation happens through `1fr` tracks, `min-width: 0` on every flex
child so truncation works, `overflow-x: auto` on the pipeline grid and waveform
lanes, and `repeat(auto-fit, minmax(300px, 1fr))` in the SPEC tab's column grid —
the one place a real reflow occurs. The only media query in the system is
`prefers-reduced-motion`.

### Named Rules

**The No-Overlay Rule.** Chrome never floats over the canvas. If a surface needs
permanent space, it becomes a grid area. Only transient, dismissible things are
positioned absolutely.

**The Shrinkable Child Rule.** Every flex child that can hold a generated name gets
`min-width: 0`. Without it the ellipsis never fires and a single long identifier
breaks the layout.

## Elevation & Depth

Depth is **layered**, and the shadow scale is real vocabulary rather than
decoration. The base separation is tonal — editor ground `#1e1e1e` → rail
`#252526` → widget `#2a2a2e` → field `#3c3c3c` — reinforced by 1px hairlines at
every boundary. On top of that sit exactly three shadow roles, each earned by a
different kind of detachment, plus a focus ring. A component that is not lifting,
detaching, or selected does not get a shadow.

### Shadow Vocabulary

- **Node lift** (`box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35)`): a block sitting on
  the canvas rather than in the layout. The gentlest step; every node has it.
- **Overlay drop** (`box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5)`): anything that has
  left the layout entirely — connect form, run-config popover, event field card.
  Always paired with a Focus Blue 1px border.
- **Selection ring** (`box-shadow: 0 0 0 2px <focus-blue>, 0 2px 8px rgba(0,0,0,.4)`):
  the node lift, doubled and ringed. Selection reads as elevation, not as fill.
- **Token glow** (`filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.35))`): the
  only luminous effect in the system, on in-flight token bubbles alone.

### Named Rules

**The Earned Shadow Rule.** Three roles, three reasons: lifting off the canvas,
detaching from the layout, being selected. A new shadow value requires a fourth
kind of detachment, not a fourth taste.

**The Hairline-First Rule.** Reach for a 1px hairline and a tonal step before
reaching for a shadow. Every divider, card edge, table cell and lane boundary in
this system is a hairline.

## Shapes

Corners are **softened, never round**. The radius scale runs 3 / 4 / 6 / 7 / 8px,
climbing with the size and independence of the surface: 3px on dense inputs, 4px on
buttons and toolbar controls, 6px on palette items and activity icons, 7px on stat
tiles and glyph wells, 8px on everything that is a real container — nodes, cards,
popovers, spec sections. Full pills (`999px`) are reserved for things that are
states rather than surfaces: status chips, badges, toggles, occupancy chips.

**Silhouette carries type on the canvas.** A block is an 8px-cornered rectangle at a
fixed 200px width. An I/O pin block is the same node at an **18px radius** — a pill,
readable as a boundary at any zoom without reading its label. Port dots and token
bubbles are perfect circles (`50%`, 11px and ~5px). Router and composite nodes keep
the block silhouette but thicken the border (2.5px) and take an orchid wash.

**Border weight and style encode authorship**, in the same grammar as the wires:

- **1.5px solid** — a generated, parser-recognized leaf block.
- **1.5px dashed** — a hand-written block. Visible, revealable, protected from
  canvas edits.
- **2.5px solid orchid** — a composite, with a `linear-gradient(180deg, #b180d712,
  transparent 40%)` wash over the widget surface.
- **Orchid + 12% color-mix fill** — a router.
- **Green, 18px pill** — an I/O boundary pin.

### Named Rules

**The Dash Rule.** This is the system's central idea and it governs both wires and
borders. A broken line means the code does not fully substantiate what you are
looking at, and the more broken the line, the less real the thing:

| Style | Meaning |
|---|---|
| solid 2px cyan | wired — `configureOut` exists in the source |
| solid orchid | routed — a router's rules own the destination |
| dashed 6 4 grey | inferred by the parser, not authored |
| dashed 8 5 orchid (1.5px, 55%) | derived ghost edge — no authored wire exists at all |
| dashed 7 5 orchid (3px, 55%) | fabric attachment; 4px for a trunk |
| dashed 5 4 focus blue | a draft being dragged right now |
| dashed 4 4 coral | unresolved — `to: null` |
| dotted 2 5 amber | a stub, dangling with its reason |

Never draw a solid line for something the parser could not read back out of the
code. Never dash something that is genuinely wired.

**The Halo Rule.** Text over the canvas (route badges, fabric errors) uses
`paint-order: stroke` with a 3px stroke in the editor background, so labels stay
readable over any wire without a background plate.

## Components

### Buttons

Four weights, all recessive at rest.

- **Shape:** softened corners (4px; 5px on 24px icon buttons).
- **Primary:** Action Blue fill, white text, no border, `4px 12px` — Run, Confirm,
  Add. At most one per surface.
- **Ghost:** transparent, inherits ink, 1px hairline border, same padding. The
  Cancel beside every primary.
- **Secondary:** `--vscode-button-secondaryBackground` (`#3a3d41`), no border,
  `5px 10px` — the inspector's action stack.
- **Toolbar / icon:** fully transparent with a transparent 1px border reserving the
  space, so hover adds `#ffffff14` background without shifting layout. Icon buttons
  are 24px squares at 0.72 opacity, rising to 1 on hover; the destructive variant
  turns coral on hover only.
- **Active state:** a toggled tool takes the Action Blue fill (`.on`). Disabled is
  `opacity: 0.4` with `cursor: default` — never a color change.

### Chips and Badges

- **Status chip:** a pill (`999px`) at `#ffffff12` with a 6px colored dot —
  neutral grey by default, Sage Green for `wired`, Alarm Coral for `unresolved`.
  One vocabulary shared by wires, ports and summaries.
- **Link badges:** tinted at ~33–55% alpha over the semantic hue — `badge-wired`
  Action Blue, `badge-inferred` grey, `badge-unresolved` coral, `badge-hand` amber.
- **Outline chips:** the SV twin chip (8.5px/700/0.5em, amber border and text) and
  the ▶ entry badge (green border and text) are borders with no fill, so they read
  as annotations on the node rather than as controls.
- **Occupancy chip:** `#ffffff18` normally, flipping to a filled Alarm Coral with
  white text when hot.

### Cards and Containers

- **Corner style:** 8px.
- **Background:** widget surface on the rail; stat tiles invert to editor ground so
  a well reads as recessed.
- **Border:** 1px hairline. Body sections are separated by an even fainter
  `#ffffff0a` rule rather than a full hairline.
- **Shadow:** none at rest — inspector cards are flat. Only popovers take the
  overlay drop (see Elevation).
- **Internal padding:** `7px 11px` on the summary row, `4px 11px 10px` on the body.
- **Behavior:** built on `<details>`. The summary row is an 11px uppercase label
  with an 8px chevron that rotates 90° over 0.15s when open, and a right-aligned
  count chip. The native marker is suppressed.

### Inputs and Fields

- **Style:** field surface fill, 1px `--vscode-input-border` (`#555`), 3–4px radius,
  `3px 6px` padding, always `min-width: 0` and `flex: 1` so they shrink.
- **Focus:** border becomes Focus Blue. The inspector name field is the signature
  variant: transparent and borderless at rest, hairline border on hover, Focus Blue
  border plus field-surface fill on focus, with `outline: none` — the border *is*
  the focus indicator.
- **Stat-tile input:** fully transparent, no border, no padding, 16px/600 mono
  tabular, spinners suppressed. It reads as a displayed number until you type in it.
- **Error:** a coral border (`.cf-invalid`); validation toasts use the host's
  `inputValidation` error background and border.
- **Dashed input:** the spec chip-input uses a 1px *dashed* border at pill radius —
  the Dash Rule applied to a field that does not exist yet.

### Navigation

- **Activity bar:** 34px transparent square buttons, 17px glyphs, at
  `activityBar-inactiveForeground`. Active takes full foreground plus a
  `#ffffff14` wash and a 6px radius.
- **Editor tabs:** flat inactive tabs separated by hairlines; the active tab takes
  the editor background, full-strength foreground, and a **1px top border** in the
  host's `tab-activeBorderTop` — the tab's only accent.
- **Panel tabs:** 11px, 0.4em letter-spacing, transparent, with a bottom-border
  underline appearing only on the active tab.
- **Breadcrumb:** transparent 0.75-opacity crumbs, full opacity and 600 weight when
  current, separated by a 10px 0.4-opacity chevron; hover adds the toolbar wash.

### Signature Component — The Block Node

The system's identity object. A fixed 200px-wide card on the canvas: a 34px header
holding a 600/12.5px truncating label and a right-aligned 10px id at 0.55 opacity;
then 20px port rows — out-ports right-aligned with an 11px cyan dot hanging 8px off
the right edge, in-ports left-aligned with their dot hanging off the left, each dot
ringed with a 2px editor-background border so it reads as a physical pin; then an
optional state-variable section behind a dashed top rule, each 16px row pairing a
mono name against a dimmed type. Border weight and style encode authorship (see
Shapes). Selected nodes take the selection ring; diverged and congested nodes pulse
coral. A ＋ handle sits at the right edge for drawing a new wire, and composite
nodes reveal `+ in` / `+ out` pill buttons below themselves on hover or selection.

### Signature Component — The Wire

An SVG path with a transparent 12px `stroke` hit-area beneath it so a 2px line is
comfortably clickable. Stroke color and dash pattern are the full status vocabulary
of the Dash Rule; selection thickens to 3.5px and adds a `currentColor` drop-shadow.
Labels are centered 10px text; route badges and fabric errors use the Halo Rule.
Under the metrics overlay a wire's stroke width scales with measured bandwidth
(`1 + 3 × bw/max`), so the busiest paths physically thicken.

### Signature Component — The Stat Tile

A two-column grid of recessed wells (editor ground, 7px radius, hairline border,
hover/focus-within brightening the border to Focus Blue). Each carries a 9px
uppercase 0.08em caption at 0.6 opacity above a 16px/600 mono tabular value, with an
optional small unit at 0.55. Wide variants span both columns. This is the one place
the system permits a large type size, and only for numbers.

### Micro-controls

- **Segmented control:** a hairline-bordered strip with `overflow: hidden` and
  square-cornered children; the selected segment takes `#0e639c55` and full opacity.
- **Toggle:** 26×15px pill, `#ffffff1e` off / `#0e639c88` on, with an 11px knob
  sliding 2px→13px over 0.15s and turning cyan when checked. The real checkbox is
  visually hidden but keeps `:focus-visible` driving an outline on the pill.
- **Stepper:** two 18×20px transparent buttons flanking a mono tabular value inside
  a single hairline-bordered, overflow-hidden container.
- **Hint row:** a colored icon glyph beside 10.5px text at 0.7 opacity; the error
  variant turns the whole row coral at full opacity.

### Motion

Every animation in this system is a status report. Two speeds: **0.15s** for state
transitions (chevron rotation, toggle knob, background changes), and **0.9–1.1s
ease-in-out infinite** for conditions that persist — `pulse` on a diverged node
(2px → 7px coral ring), `congest-pulse` on a saturated router (2px → 8px), and
`dwell-pulse` on a token stalled in a block (radius 5 → 6.5, opacity 0.95 → 0.55).
Token movement itself is driven from the real trace geometry, not from CSS.
`prefers-reduced-motion: reduce` currently disables the chevron and toggle
transitions.

## Do's and Don'ts

### Do:

- **Do** write every color as `var(--vscode-TOKEN, fallback)` and use the canonical
  fallback for its semantic hue — `#4fc3f7` cyan, `#b180d7` orchid, `#89d185` sage,
  `#ffb74d` amber, `#ef5350` coral, `#f9a825` yellow.
- **Do** encode connection truth in the stroke: solid for wired, dashed for inferred
  or derived, dotted for stubs, coral for unresolved. Follow the Dash Rule table
  exactly rather than inventing a new dash pattern.
- **Do** put `min-width: 0` on every flex child that can receive a generated
  identifier, alongside `nowrap` / `overflow: hidden` / `text-overflow: ellipsis`.
- **Do** set anything that appears verbatim in the user's source — member names,
  mnemonics, hex addresses, function names, waveform values — in
  `var(--vscode-editor-font-family, monospace)`, with `tabular-nums` on comparable
  numbers.
- **Do** dim secondary text with opacity (0.5 / 0.65 / 0.8) rather than introducing
  a second ink color, so hierarchy survives any host theme.
- **Do** give new permanent surfaces a named grid area in the shell; keep absolute
  positioning for genuinely transient overlays only.
- **Do** pair every primary Action Blue button with a ghost cancel, and keep at most
  one primary per surface.
- **Do** snap canvas geometry to the 8px grid and keep node width at 200px.
- **Do** state a failure visibly — coral stroke, `⛔` badge, dangling stub with its
  reason — in preference to hiding it or silently degrading.

### Don't:

- **Don't** float chrome over the canvas. If it needs permanent space it belongs in
  the grid.
- **Don't** reuse a hue for a second meaning. Cyan is never decorative, amber is
  never an error, orchid is never a generic highlight, yellow is only the playhead.
- **Don't** add a fourth shadow. Three roles exist — node lift, overlay drop,
  selection ring — and each answers a distinct kind of detachment. Reach for a
  hairline and a tonal step first.
- **Don't** animate anything that is not reporting state. There are no entrance
  animations, no decorative transitions, and no motion without a condition behind it.
- **Don't** use a border radius above 8px on a surface. Pills (`999px`) are for
  states, and the 18px node radius is reserved exclusively for I/O boundary pins.
- **Don't** exceed 16px type, and don't use that size for anything but a number.
- **Don't** introduce a third font family or a display face.
- **Don't** use a raw hex without a `--vscode-*` variable behind it, unless the value
  has no host equivalent (the eight-color token ramp, the block-id pipeline hash).
- **Don't** widen a node or let a long generated name wrap — truncate and expose the
  full string via `title`.
- **Don't** convey disabled state with color; use `opacity: 0.4` and
  `cursor: default`.
