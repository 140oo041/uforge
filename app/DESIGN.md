---
name: ISS Desktop — Provenance Ribbon
description: A custody record for a design: every line, number and block declares whether the code substantiates it, or admits it does not.
scope: app/ (the standalone desktop app). The VS Code extension stays theme-parasitic — see ../DESIGN.md.
colors:
  archival-buff: "#f2e8d6"
  ribbon-red: "#a52b2b"
  ribbon-deep: "#7d1f1f"
  unwoven-gray: "#b7b2ac"
  unwoven-ink: "#847c72"
  ledger-ink: "#1c1c1c"
  fading-ink: "#5a6270"
  vellum: "#faf4e8"
  binding: "#e2d5bd"
  stamp-violet: "#5d4a7a"
  verdigris: "#3f6b5c"
  oxide: "#94571f"
typography:
  display:
    fontFamily: "'Bitstream Charter', Charter, Georgia, serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.05
  title:
    fontFamily: "'Bitstream Charter', Charter, Georgia, serif"
    fontSize: "15px"
    fontWeight: 700
  body:
    fontFamily: "'Bitstream Charter', Charter, Georgia, serif"
    fontSize: "12.5px"
    lineHeight: 1.5
  smallcap:
    fontFamily: "'Bitstream Charter', Charter, Georgia, serif"
    fontSize: "9.5px"
    fontWeight: 600
    letterSpacing: "0.14em"
    textTransform: "uppercase"
  ledger:
    fontFamily: "ui-monospace, 'Cascadia Mono', monospace"
    fontSize: "10.5px"
    fontFeature: "tabular-nums"
rounded:
  none: "0px"
  card: "2px"
---

# Design System: ISS Desktop — Provenance Ribbon

## Overview

**Creative North Star: "A custody record for a design."**

A provenance record states what is known, what is inferred, and what is missing —
and it never lets the three look alike. That is already this product's central
claim: a wire is solid only when `configureOut` exists in the source, dashed when
the parser inferred it, dotted when it is a stub. This world takes that idea and
extends it to everything the surface says.

The ribbon is the wire. It runs red and continuous where the code substantiates
it, and **frays into unwoven grey thread wherever custody breaks** — an
unresolved link, a dangling stub, the gap after the clock stopped. A fold in the
ribbon, marked by a lozenge, is a port. A stamp is a claim by an authority other
than the author: a router's forwarding rule, a hand-written block, a
SystemVerilog twin.

The atmosphere is **archival, exact, and unhurried under load** — an object's
file laid out on a conservator's bench, not a dashboard. Buff ground, ledger
ink, hairline rules, one red. It raises its voice only when something happened.

**The rut this replaces:** the previous surface was VS Code cosplay — `#1e1e1e`,
12px system sans, an activity bar and a CONSOLE/PROBLEMS dock. It read as a
decade old because it *was* the category default. Its predictable opposite, the
near-black-plus-indigo-gradient "modern dev tool," is equally out of bounds.

## The Custody Rule

**This is the system's one idea, and it governs type, stroke and fill alike.**
Four states, one vocabulary, everywhere:

| State | Stroke | Type | Meaning |
|---|---|---|---|
| **Documented** | solid 2px ribbon red | solid ledger ink | the source substantiates it |
| **Attested** | solid + stamp mark | solid, with a stamp | an authority other than the author owns it — a router's rules, an SV twin |
| **Inferred** | 1.5px hairline, 8 5 dash | outline / hairline type | the parser deduced it; nobody wrote it |
| **Silent** | frayed unwoven-ink thread | dotted-outline type | no record: a stub, or a gap after the clock stopped |
| **Disputed** | frayed, in ribbon red | ditto, in red | the link points at nothing |

Never draw a documented stroke for something the parser could not read back out
of the code. Never fray a line that is genuinely wired.

**Measured after the first build.** Three values changed on contact with the
ground and the reasons are binding:

- `unwoven-gray #b7b2ac` from the source card measures **1.73:1** on buff. A
  2px thread of it is invisible, and a custody state that cannot be seen is
  worse than no notation at all. The pale tone is kept for fills and woven
  texture; every *stroke and label* of silence takes `unwoven-ink #847c72`
  (3.39:1). Likewise `fading-ink` darkened to `#5a6270` (5.06:1, it carries
  body text) and `oxide` to `#94571f` (4.75:1, it is set at 8.5px).
- **Disputed is not a third grey.** An unresolved link is a failure, and this
  system gives failure the ribbon red at full weight — frayed, so it reads as
  both broken and missing, and never as a decorative pink.
- **Fraying is carried by an irregular dash** (`1 3 2.5 2 1 3.5 2 2`, round
  caps), not by the SVG displacement filter. A perfectly horizontal wire has a
  zero-height bounding box, which collapses an `objectBoundingBox` filter
  region and renders nothing at all. The filter stays layered on the curved
  bench runs as an enhancement; where it no-ops, the thread still reads.

### The Number Provenance Rule

The old system had no answer for this and it was its largest hole: a latency the
architect *typed* and a queue depth the engine *measured* rendered identically.
Here they cannot:

- A **measured** number — from a run that happened — is set solid, in ledger
  ink, and carries a hairline underline: it is documented.
- An **entered** number is set in the same face at the same size but in
  `fading-ink`, with no underline: it is an assertion, not a record.
- A number with **no run behind it yet** shows as dotted-outline em-dashes.

## Colors

**Ground.** `archival-buff #f2e8d6` is the working surface; `vellum #faf4e8`
lifts panels off it; `binding #e2d5bd` is the hairline and every rule. Depth is
paper stacked on paper — a tonal step plus one hairline, never a drop shadow
outside a true overlay.

**Ink.** `ledger-ink #1c1c1c` is body. `fading-ink #6d7480` is everything
secondary, entered rather than measured, or not yet resolved. Secondary text is
a *second ink*, not an opacity — a faded record is a real thing in this world.

**The one red.** `ribbon-red #a52b2b` is custody: the wire that exists, the
active state, the primary action, the date at every fold. `ribbon-deep #7d1f1f`
is its pressed state. Red is never decorative — if something is red, the code
substantiates it or you are about to act on it.

**Silence.** `unwoven-gray #b7b2ac` is the absence of record, and the only
texture in the system.

**The stamps.** Three inks for authorities other than the author, used as
outlined marks and never as fills: `stamp-violet #5d4a7a` for the fabric (a
router's rules own this), `verdigris #3f6b5c` for a confirmed boundary pin, and
`oxide #b06a2c` for hand-authored work the writer must not touch. Failure has no
stamp: it takes the ribbon red at full weight, because a failure is a custody
claim, not an annotation.

## Typography

**Text face:** Bitstream Charter — Matthew Carter's ledger serif, drawn for
exactly these constraints (small sizes, screen rendering, dense tabular
material). Georgia is the fallback. **Identifier face:** the system mono.

**The Identifier Rule survives from the old system unchanged:** anything that
exists verbatim in the user's C++, SystemVerilog or spec JSON is set in mono.
The interface talking *about* that code is set in Charter. A record quotes its
sources exactly.

**Small caps carry every label.** 9.5px, 600, `0.14em` — section headings, port
names, chip text, tab labels. This is where most of the interface lives, and it
is what makes a dense surface read as a record rather than a form.

Display is 26px Charter Bold and appears roughly once per screen. Unlike the old
system, type *may* exceed 16px — but only for a name, never for chrome.

## Cosmetic modes

The world above is one of five, chosen from the record bar and remembered. They
are costumes: identical behaviour, identical semantics, identical canvas. What
makes that cheap is the token contract — the shell and the canvas read `--ui-*`
and `--vscode-*` and never a skin's own materials, so a skin is a set of answers
rather than a fork.

| | |
|---|---|
| **Record** | this document's world — archival paper, ledger serif, custody in stroke and ink |
| **Glass** | translucent modules hovering over a lit field; blur earns itself by having real light to refract |
| **Blueprint** | cyanotype drafting sheet: no fills anywhere, weight is the only hierarchy, single-stroke gothic caps |
| **Terminal** | one phosphor, one family, scanlines and bloom; custody carried by brightness and dash because a P1 tube has no second hue |
| **Paper** | white, hairline, one blue, no texture at all — for a bright desk and an hour before review |

**Every skin is scoped**, including this one (`[data-skin='record']`). None is an
unscoped base the others must fight — that was the arrangement when there were
two, and it does not survive five.

**Custody survives every skin.** A mode may change what documented *looks* like;
it may never make documented and inferred look the same. Where a world forbids
the usual channel — Terminal has one hue — the distinction moves to another
channel rather than being dropped.

## Layout — the bench

**The design gets the window.** The IDE shell this app started from parks four
permanent walls around the work: a 44px activity bar, a 200px palette, a 250px
inspector and a 190px dock. On a 1600×1000 window that is 494px of width and
281px of height — the design gets **50%** of the screen it is running on. Inside
VS Code that trade is right, because the surface is a panel among panels.
Standing alone it is furniture, and it is the single largest reason the app read
as a decade old.

The bench keeps **one 38px record strip and one 26px ledger** — about 7% — and
summons everything else:

- **The inspector appears on selection and leaves when the selection clears.** A
  permanent column reporting "9 leaves · 2 composites" is a wall you pay for on
  every screen and read on none of them.
- **The library is a command palette (⌘K)**, not a rail of eleven cards. A query
  matching no template is treated as a new class name rather than as a failed
  search.
- **The dock is a hairline strip** that reports phase, oracle and cycle, and
  opens on click — or by itself when a run errors or leaves problems, because
  the architect should never go looking for why a run failed.
- **Camera and history float** at the bench's corner instead of owning a toolbar.

**The overlay rule is inverted from the old system.** Its No-Overlay Rule
("if a surface needs permanent space, it becomes a grid area") is exactly what
produced the walls. Here: *nothing earns permanent space except the record strip
and the ledger.* Everything else is summoned, floats over the bench, and leaves.

### The Visible-By-Default Rule

An entrance animation may never be the thing that makes content visible.
`animation-fill-mode: both` pins an element at its `from` state whenever the
animation does not run — and Chromium suspends animations in a hidden or
backgrounded window, so `from { opacity: 0 }` renders a permanently invisible
panel. Entrances use `forwards`, so an animation that never runs leaves the
element at its own resting style. Motion is an enhancement on top of a surface
that is already correct.

## Shapes

**Corners are square.** 0px on every surface; 2px only where a real card edge
needs to not look broken. The old 8px-everywhere softness is the single biggest
reason it read as 2010s, and it is gone. Pills are gone with it: a state is
shown by a stamp outline or a rule, not by a lozenge of background.

**The lozenge** (a 6px rotated square) is the one repeated ornament, and it is
structural: it marks a fold in the ribbon — a port, a date, a hop.

**Rules over fills.** A 1px `binding` hairline is the primary device. Cards are
a left 2px ribbon-red rule plus a hairline box; they are never a filled
rectangle with a shadow.

## Motion

Motion reports custody and nothing else. **0.12s** for state changes. The one
authored moment: on a completed run, the ribbon **draws** along the real hop
geometry from source to sink — `stroke-dashoffset` over the true path — so the
trace arrives as a record being written rather than as a diagram appearing.
Frayed segments never animate; silence does not perform. `prefers-reduced-motion`
disables the draw and shows the final state.

## Do's and Don'ts

### Do
- Encode custody in stroke, type and ink together — the four states above.
- Mark measured numbers apart from entered ones. Always.
- Use a second ink for secondary text, not an opacity.
- Reach for a hairline rule and a tonal paper step before any shadow.
- Set identifiers in mono; set the interface in Charter.
- Fray, visibly, wherever the record is missing.

### Don't
- Round a corner past 2px, or use a pill for a state.
- Use red for anything that is not custody or a primary action.
- Add a fourth stamp ink; find the authority the existing three already name.
- Animate anything that is not reporting a state change or drawing a real trace.
- Put a drop shadow on anything that has not left the layout.
- Show a number without saying, in its rendering, where it came from.
