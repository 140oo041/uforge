// Per-file fact extraction: one C++ source → the facts the graph assembler
// needs. Pure, deterministic, and fast (a structural scanner, not a full C++
// parser) — the recognized slice is the engine vocabulary:
//
//   S1  class X : public Component            → block
//   S2  : Component("label") in a ctor init   → block label
//   S3  class E : public Event { fields }     → message + payload
//   S4  Link* member; / Link& member;         → out-port
//   S5  port->configureIn(this)               → (no fact; source is implied)
//   S6  port->configureOut(registry.find("Y"))→ wire  (Tier-1, solid)
//       port->configureOut(&y)                → wire  (dest by instance name)
//   S7  port->latency = N / setLatency(N)     → latency
//   B1  make_unique<E>() … port->send(move(v))→ emit  (keyed per (class,port))
//   B2  static_cast<E&>(ev)                   → consume
//       void handler(E& ev)  (typed handler)  → consume  (base `Event&` excluded)
//       ev.type() == "E"                      → consume
//   V1  <type> <name> [= init];  at class depth-1 → state variable
//   H1  namespace NS { … }                    → hierarchy: class ids become
//                                               dot-paths ("CPU0.IF")
//
// Facts are attributed to the enclosing class: either the class body (inline
// methods) or an out-of-line `Ret X::method(...) { … }` definition. Facts in
// free functions (e.g. a generated harness main()) are deliberately dropped —
// blocks own their wiring in v2.

import type { SourceRange } from '@iss/contracts/graph';

export interface ClassFact {
  /** Qualified dot-path name ("CPU0.IF"). */
  name: string;
  /** Base class, unqualified ("Component" | "Event" | "Router" | other). */
  base: string;
  decl: SourceRange;
  label?: string;
  /** Event payload fields, or Component state variables — "name:type". */
  fields: string[];
  /** Router classes only: latency-model member functions
   *  (`microarch::Cycle name(const microarch::Event&)`). */
  models?: string[];
}

export interface PortFact {
  cls: string;
  port: string;
  decl: SourceRange;
}

export interface WireFact {
  cls: string;
  port: string;
  dest: string;
}

export interface LatencyFact {
  cls: string;
  port: string;
  latency: number;
}

export interface EmitFact {
  cls: string;
  port: string;
  message: string;
}

export interface ConsumeFact {
  cls: string;
  message: string;
}

export interface HandlerFact {
  cls: string;
  range: SourceRange;
}

/** `: Component("label")` seen in a ctor init list — may be in the .cpp while
 *  the class body is in the .h, so it travels as its own cross-file fact. */
export interface LabelFact {
  cls: string;
  label: string;
}

export interface FileFacts {
  file: string;
  classes: ClassFact[];
  ports: PortFact[];
  wires: WireFact[];
  latencies: LatencyFact[];
  emits: EmitFact[];
  consumes: ConsumeFact[];
  handlers: HandlerFact[];
  labels: LabelFact[];
}

/** Replace // and /* comments with spaces (newlines preserved). */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  let mode: 'code' | 'line' | 'block' | 'str' | 'chr' = 'code';
  while (i < n) {
    const c = text[i];
    const next = i + 1 < n ? text[i + 1] : '';
    switch (mode) {
      case 'code':
        if (c === '/' && next === '/') {
          mode = 'line';
          out += '  ';
          i += 2;
        } else if (c === '/' && next === '*') {
          mode = 'block';
          out += '  ';
          i += 2;
        } else if (c === '"') {
          mode = 'str';
          out += c;
          i++;
        } else if (c === "'") {
          mode = 'chr';
          out += c;
          i++;
        } else {
          out += c;
          i++;
        }
        break;
      case 'line':
        if (c === '\n') {
          mode = 'code';
          out += c;
        } else {
          out += ' ';
        }
        i++;
        break;
      case 'block':
        if (c === '*' && next === '/') {
          mode = 'code';
          out += '  ';
          i += 2;
        } else {
          out += c === '\n' ? c : ' ';
          i++;
        }
        break;
      case 'str':
        if (c === '\\') {
          out += text.slice(i, i + 2);
          i += 2;
        } else {
          if (c === '"') mode = 'code';
          out += c;
          i++;
        }
        break;
      case 'chr':
        if (c === '\\') {
          out += text.slice(i, i + 2);
          i += 2;
        } else {
          if (c === "'") mode = 'code';
          out += c;
          i++;
        }
        break;
    }
  }
  return out;
}

class LineIndex {
  private starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++)
      if (text[i] === '\n') this.starts.push(i + 1);
  }
  /** offset → { line, col }, both 1-based. */
  at(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.starts[lo] + 1 };
  }
}

/** Find the offset of the matching '}' for the '{' at `open`. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

/**
 * The class body restricted to its own top level: nested `{…}` regions
 * (inline method bodies) blanked out, newlines preserved — so a line-based
 * member scan can't false-match handler locals.
 */
function topLevelOfBody(body: string): string {
  let out = '';
  let depth = 0; // relative to the body's outer '{'
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") {
      const quote = c;
      out += depth === 1 ? c : ' ';
      i++;
      while (i < body.length && body[i] !== quote) {
        const cc = body[i];
        out += depth === 1 ? cc : cc === '\n' ? cc : ' ';
        if (cc === '\\') {
          i++;
          if (i < body.length) out += depth === 1 ? body[i] : ' ';
        }
        i++;
      }
      if (i < body.length) out += depth === 1 ? body[i] : ' ';
      continue;
    }
    if (c === '{') {
      depth++;
      out += depth === 1 ? c : ' ';
    } else if (c === '}') {
      out += depth === 1 ? c : ' ';
      depth--;
    } else {
      out += depth === 1 || c === '\n' ? c : ' ';
    }
  }
  return out;
}

interface Scope {
  cls: string;
  start: number;
  end: number;
}

const RE_NAMESPACE = /\bnamespace\s+([A-Za-z_]\w*)\s*\{/g;
// `struct X final : Event` carries an implicit public base — the keyword is
// optional in the recognized slice. `enum class X : uint8_t` must NOT match
// (the generated arch header declares signal enums). The base may be
// namespace-qualified (`: public microarch::Router`) — captured unqualified.
const RE_CLASS =
  /(?<!enum\s{0,8})\b(?:class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?:\s*(?:public\s+|protected\s+|private\s+)?(?:microarch\s*::\s*)?([A-Za-z_]\w*)/g;
// A router latency model: a member function returning cycles for one packet.
const RE_LATENCY_MODEL =
  /\b(?:microarch\s*::\s*)?Cycle\s+([A-Za-z_]\w*)\s*\(\s*const\s+(?:microarch\s*::\s*)?Event\s*&/g;
const RE_METHOD_DEF =
  /\b((?:[A-Za-z_]\w*::)+)([A-Za-z_~]\w*)\s*\([^;{)]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?::[^{;]*)?\{/g;
const RE_LINK_MEMBER = /\bLink\s*[*&]\s*([A-Za-z_]\w*)\s*(?:=\s*nullptr\s*)?;/g;
const RE_LABEL = /\bComponent\s*\(\s*"([^"]*)"\s*\)/;
const RE_LABEL_G = /\bComponent\s*\(\s*"([^"]*)"\s*\)/g;
const RE_WIRE_REGISTRY =
  /\b([A-Za-z_]\w*)\s*(?:->|\.)\s*configureOut\s*\(\s*(?:[A-Za-z_]\w*)\s*\.\s*(?:find|at)\s*\(\s*"([A-Za-z_][\w.]*)"\s*\)\s*\)/g;
const RE_WIRE_ADDR = /\b([A-Za-z_]\w*)\s*(?:->|\.)\s*configureOut\s*\(\s*&\s*([A-Za-z_]\w*)\s*\)/g;
const RE_LATENCY = /\b([A-Za-z_]\w*)\s*(?:->|\.)\s*latency\s*=\s*(\d+)/g;
const RE_SET_LATENCY = /\b([A-Za-z_]\w*)\s*(?:->|\.)\s*setLatency\s*\(\s*(\d+)\s*\)/g;
const RE_MAKE_UNIQUE = /\bauto\s+([A-Za-z_]\w*)\s*=\s*std::make_unique\s*<\s*([A-Za-z_]\w*)\s*>/g;
const RE_SEND_MOVE =
  /\b([A-Za-z_]\w*)\s*(?:->|\.)\s*send\s*\(\s*std::move\s*\(\s*([A-Za-z_]\w*)\s*\)\s*\)/g;
const RE_SEND_INLINE =
  /\b([A-Za-z_]\w*)\s*(?:->|\.)\s*send\s*\(\s*std::make_unique\s*<\s*([A-Za-z_]\w*)\s*>/g;
const RE_SEND_TEMPLATE = /\b([A-Za-z_]\w*)\s*(?:->|\.)\s*send\s*<\s*([A-Za-z_]\w*)\s*>/g;
const RE_CAST = /\b(?:static_cast|dynamic_cast)\s*<\s*([A-Za-z_]\w*)\s*&\s*>/g;
/**
 * A typed handler declares what a block consumes just as plainly as a cast
 * does: `void handle(PingEvent& e)`. The writer emits the cast form, so
 * generated projects were fine — but a hand-written block that overloads
 * handle() reported an empty `consumes`, and since Tier-2 inference matches a
 * port's message against consumers, *no inferred link could ever be produced*
 * for hand-written code. That is why inferred wires never appeared.
 *
 * The generic base override `handle(microarch::Event&)` is the dispatch entry
 * point, not a claim about a message type, so it is excluded below.
 */
const RE_HANDLE_TYPED =
  /\bhandler?\s*\(\s*(?:const\s+)?(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)\s*&/g;
/**
 * The other way a block declares what it consumes, and the one the writer
 * itself emits: `if (ev.type() == "StallEvent")`. Detecting the string means a
 * block that dispatches on type but never casts is still recognised.
 */
const RE_TYPE_TEST = /\.\s*type\s*\(\s*\)\s*==\s*"([A-Za-z_]\w*)"/g;
const RE_FIELD =
  /^\s*((?:unsigned\s+|signed\s+|std::)?[A-Za-z_][\w:]*(?:\s*<[^;>]*>)?)\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;\s*$/;

const FIELD_TYPE_BLOCKLIST = new Set([
  'class',
  'struct',
  'return',
  'using',
  'typedef',
  'friend',
  'auto',
  'Link',
  'Event',
  'explicit',
]);

export function extractFacts(file: string, source: string): FileFacts {
  const text = stripComments(source);
  const lines = new LineIndex(text);
  const facts: FileFacts = {
    file,
    classes: [],
    ports: [],
    wires: [],
    latencies: [],
    emits: [],
    consumes: [],
    handlers: [],
    labels: [],
  };

  // 0. Namespace scopes (nestable). A class inside `namespace CPU0 { … }`
  //    gets the qualified dot-path name "CPU0.<Class>".
  const namespaces: Array<{ name: string; start: number; end: number }> = [];
  RE_NAMESPACE.lastIndex = 0;
  for (let m = RE_NAMESPACE.exec(text); m; m = RE_NAMESPACE.exec(text)) {
    const open = m.index + m[0].length - 1;
    namespaces.push({ name: m[1], start: open, end: matchBrace(text, open) });
  }
  const namespacePathAt = (offset: number): string[] =>
    namespaces
      .filter((ns) => offset >= ns.start && offset <= ns.end)
      .sort((a, b) => a.start - b.start)
      .map((ns) => ns.name);
  const qualify = (offset: number, name: string): string =>
    [...namespacePathAt(offset), name].join('.');

  // 1. Classes and their body extents.
  const classBodies: Scope[] = [];
  RE_CLASS.lastIndex = 0;
  for (let m = RE_CLASS.exec(text); m; m = RE_CLASS.exec(text)) {
    const open = text.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    const close = matchBrace(text, open);
    const start = lines.at(m.index);
    const end = lines.at(close);
    facts.classes.push({
      name: qualify(m.index, m[1]),
      base: m[2],
      decl: {
        file,
        line: start.line,
        col: start.col,
        endLine: end.line,
        endCol: end.col,
      },
      fields: [],
    });
    classBodies.push({ cls: qualify(m.index, m[1]), start: open, end: close });
  }

  // 2. Out-of-line method definitions (`X::method(...) { … }`, possibly
  //    namespace-qualified `CPU0::IF::handler`).
  const methodBodies: Scope[] = [];
  RE_METHOD_DEF.lastIndex = 0;
  for (let m = RE_METHOD_DEF.exec(text); m; m = RE_METHOD_DEF.exec(text)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(text, open);
    const qualifiers = m[1].replace(/::$/, '').split('::');
    const clsPath = [...namespacePathAt(m.index), ...qualifiers].join('.');
    methodBodies.push({ cls: clsPath, start: m.index, end: close });
    if (m[2] === 'handler') {
      const start = lines.at(m.index);
      const end = lines.at(close);
      facts.handlers.push({
        cls: clsPath,
        range: { file, line: start.line, col: start.col, endLine: end.line, endCol: end.col },
      });
    }
  }

  const scopes: Scope[] = [...classBodies, ...methodBodies];
  const classAt = (offset: number): string | null => {
    let best: Scope | null = null;
    for (const scope of scopes) {
      if (offset >= scope.start && offset <= scope.end) {
        if (!best || scope.end - scope.start < best.end - best.start) best = scope;
      }
    }
    return best ? best.cls : null;
  };

  // 3. Per-class body facts: label, Link members, member fields, inline handler.
  for (const scope of classBodies) {
    const body = text.slice(scope.start, scope.end + 1);
    const cls = facts.classes.find((c) => c.name === scope.cls)!;

    const label = RE_LABEL.exec(body);
    if (label) cls.label = label[1];

    RE_LINK_MEMBER.lastIndex = 0;
    for (let m = RE_LINK_MEMBER.exec(body); m; m = RE_LINK_MEMBER.exec(body)) {
      const at = lines.at(scope.start + m.index);
      facts.ports.push({
        cls: scope.cls,
        port: m[1],
        decl: { file, line: at.line, col: at.col, endLine: at.line, endCol: at.col + m[0].length },
      });
    }

    // Member fields at the class's own depth only — inline method bodies are
    // blanked so handler locals can't be mistaken for state.
    if (cls.base === 'Event' || cls.base === 'Component') {
      const topLevel = topLevelOfBody(body);
      for (const raw of topLevel.split('\n')) {
        const m = RE_FIELD.exec(raw);
        if (!m) continue;
        const type = m[1].trim();
        if (FIELD_TYPE_BLOCKLIST.has(type)) continue;
        cls.fields.push(`${m[2]}:${type}`);
      }
    }

    // Router latency models at the class's own depth (signatures survive the
    // body blanking — only nested `{…}` regions are erased).
    if (cls.base === 'Router') {
      const topLevel = topLevelOfBody(body);
      const models: string[] = [];
      RE_LATENCY_MODEL.lastIndex = 0;
      for (let m = RE_LATENCY_MODEL.exec(topLevel); m; m = RE_LATENCY_MODEL.exec(topLevel))
        if (!models.includes(m[1])) models.push(m[1]);
      if (models.length > 0) cls.models = models;
    }

    // Only a definition (`{`) counts as the handler location — a declaration
    // (`void handler(Event&) override;`) must not shadow the .cpp definition.
    const inlineHandler = /\bvoid\s+handler\s*\([^;{)]*\)\s*(?:const\s*)?(?:override\s*)?\{/.exec(body);
    if (inlineHandler && !facts.handlers.some((h) => h.cls === scope.cls)) {
      const at = lines.at(scope.start + inlineHandler.index);
      facts.handlers.push({
        cls: scope.cls,
        range: { file, line: at.line, col: at.col, endLine: at.line, endCol: at.col },
      });
    }
  }

  // 4. Behavioral facts, attributed via enclosing scope.
  const scan = <T>(
    re: RegExp,
    make: (m: RegExpExecArray, cls: string) => T | null,
    sink: T[],
  ) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const cls = classAt(m.index);
      if (!cls) continue; // free function (harness main etc.) — dropped
      const fact = make(m, cls);
      if (fact) sink.push(fact);
    }
  };

  scan(RE_WIRE_REGISTRY, (m, cls) => ({ cls, port: m[1], dest: m[2] }), facts.wires);
  scan(
    RE_WIRE_ADDR,
    (m, cls) => ({ cls, port: m[1], dest: m[2].replace(/^s_/, '') }),
    facts.wires,
  );
  scan(RE_LATENCY, (m, cls) => ({ cls, port: m[1], latency: Number(m[2]) }), facts.latencies);
  scan(RE_SET_LATENCY, (m, cls) => ({ cls, port: m[1], latency: Number(m[2]) }), facts.latencies);

  // Emits: pair `auto v = make_unique<E>()` declarations with `port->send(move(v))`
  // *per class*, plus the two direct forms. Keyed per (class, port) — the v1
  // makeUniqueByClass last-wins-per-class bug is structurally avoided.
  const varEvent = new Map<string, string>(); // `${cls}:${var}` → event
  RE_MAKE_UNIQUE.lastIndex = 0;
  for (let m = RE_MAKE_UNIQUE.exec(text); m; m = RE_MAKE_UNIQUE.exec(text)) {
    const cls = classAt(m.index);
    if (cls) varEvent.set(`${cls}:${m[1]}`, m[2]);
  }
  scan(
    RE_SEND_MOVE,
    (m, cls) => {
      const message = varEvent.get(`${cls}:${m[2]}`);
      return message ? { cls, port: m[1], message } : null;
    },
    facts.emits,
  );
  scan(RE_SEND_INLINE, (m, cls) => ({ cls, port: m[1], message: m[2] }), facts.emits);
  scan(RE_SEND_TEMPLATE, (m, cls) => ({ cls, port: m[1], message: m[2] }), facts.emits);
  scan(RE_CAST, (m, cls) => ({ cls, message: m[1] }), facts.consumes);
  // `Event` alone is the base dispatch signature, not a consumed message type.
  scan(
    RE_HANDLE_TYPED,
    (m, cls) => (m[1] === 'Event' ? null : { cls, message: m[1] }),
    facts.consumes,
  );
  scan(RE_TYPE_TEST, (m, cls) => ({ cls, message: m[1] }), facts.consumes);

  // Labels can appear in an out-of-line ctor's init list (`DE::DE(...) :
  // Component("DE") …`) — the method-definition regex stops at '{' but the
  // init list precedes it, so attribute by nearest preceding `Cls::Cls`.
  RE_LABEL_G.lastIndex = 0;
  for (let m = RE_LABEL_G.exec(text); m; m = RE_LABEL_G.exec(text)) {
    let cls = classAt(m.index);
    if (!cls) {
      const before = text.slice(Math.max(0, m.index - 400), m.index);
      const ctor = [...before.matchAll(/\b([A-Za-z_]\w*)::\1\s*\(/g)].pop();
      cls = ctor ? qualify(m.index, ctor[1]) : null;
    }
    if (cls) facts.labels.push({ cls, label: m[1] });
  }

  return facts;
}
