// Renders the real sample project into preview data for preview/preview.html:
// parses ../sample with the real parser, loads the real run trace if present
// (else synthesizes one), and writes preview/data.js.
// Run: npx tsx scripts/dump-preview.ts

import * as fs from 'fs';
import * as path from 'path';

import { parseProject } from '../src/parser';
import { parseTrace, isThin } from '../src/trace/parse';
import { synthesizeTrace } from '../src/trace/synthesize';

const sample = path.resolve(__dirname, '..', '..', 'sample');
const previewDir = path.resolve(__dirname, '..', 'preview');
fs.mkdirSync(previewDir, { recursive: true });

const graph = parseProject([sample]);
const traceFile = path.join(sample, 'iss_trace.jsonl');
let trace = fs.existsSync(traceFile)
  ? parseTrace(fs.readFileSync(traceFile, 'utf8'), graph)
  : synthesizeTrace(graph);
if (isThin(trace)) trace = synthesizeTrace(graph);

const payload = { graph, trace };
fs.writeFileSync(
  path.join(previewDir, 'data.js'),
  `window.__ISS_PREVIEW__ = ${JSON.stringify(payload)};\n`,
);
console.log(
  `preview/data.js: ${graph.components.length} blocks, ${graph.links.length} links ` +
    `(${graph.links.filter((l) => l.status === 'wired').length} wired), ` +
    `${trace.hops.length} hops (${trace.source})`,
);
