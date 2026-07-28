// Spec persistence: <projectRoot>/iss_spec.json. When absent, migrates from
// the legacy iss_isa.json overlay (RV32I base + custom instructions/state);
// returns null when neither exists (the designer offers templates).

import * as fs from 'fs';
import * as path from 'path';

import {
  TEMPLATE_RV32I,
  isSpecDocument,
  type SpecDocument,
} from '@iss/contracts/spec';

export function specPath(projectRoot: string): string {
  return path.join(projectRoot, 'iss_spec.json');
}

const LEGACY_ISA = 'iss_isa.json';

interface LegacyOverlay {
  instructions?: Array<{ mnemonic: string; type?: string; summary?: string }>;
  state?: Array<{ name: string; label?: string; bits?: number; count?: number }>;
}

/** Legacy iss_isa.json (RV32I base + overlay) → a SpecDocument. */
export function migrateLegacyOverlay(overlay: LegacyOverlay): SpecDocument {
  const spec: SpecDocument = JSON.parse(JSON.stringify(TEMPLATE_RV32I)) as SpecDocument;
  for (const s of overlay.state ?? []) {
    if (!s.name) continue;
    spec.state = [
      ...spec.state.filter((e) => e.name !== s.name),
      { name: s.name, label: s.label ?? s.name, bits: s.bits ?? 32, count: s.count, space: 'reg' },
    ];
  }
  for (const i of overlay.instructions ?? []) {
    if (!i.mnemonic) continue;
    spec.operations = [
      ...spec.operations.filter((o) => o.mnemonic !== i.mnemonic),
      { mnemonic: i.mnemonic, format: i.type, summary: i.summary ?? '', oracle: false },
    ];
  }
  return spec;
}

/** v1 spec files predate types/signals/io — normalize in place. */
export function normalizeSpec(spec: SpecDocument): SpecDocument {
  spec.types = spec.types ?? [];
  spec.signals = spec.signals ?? [];
  spec.io = spec.io ?? [];
  return spec;
}

export function loadSpec(projectRoot: string): SpecDocument | null {
  try {
    const raw = JSON.parse(fs.readFileSync(specPath(projectRoot), 'utf8')) as unknown;
    if (isSpecDocument(raw)) return normalizeSpec(raw);
  } catch {
    // fall through to migration
  }
  const legacy = path.join(projectRoot, LEGACY_ISA);
  if (fs.existsSync(legacy)) {
    try {
      const overlay = JSON.parse(fs.readFileSync(legacy, 'utf8')) as LegacyOverlay;
      const spec = migrateLegacyOverlay(overlay);
      saveSpec(projectRoot, spec); // persist the migration once
      return spec;
    } catch {
      return null;
    }
  }
  return null;
}

export function saveSpec(projectRoot: string, spec: SpecDocument): void {
  fs.writeFileSync(specPath(projectRoot), JSON.stringify(spec, null, 2) + '\n');
}
