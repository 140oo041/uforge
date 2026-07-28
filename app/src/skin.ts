// Cosmetic modes.
//
// Two complete visual worlds over one application. The skin is written to
// <html data-skin>, every skin stylesheet is scoped to that attribute, and the
// canvas is untouched by either — it reads --vscode-* tokens, and a skin is
// just a different set of answers.
//
//   record  the provenance ribbon: archival paper, ledger serif, one red,
//           custody encoded in stroke and ink. Calm, flat, edge-to-edge.
//   glass   modular translucent panels floating over a lit field, with lift
//           on hover. Dark, layered, spatial.

export const SKINS = [
  { id: 'record', label: 'Record', note: 'archival paper, ledger serif, custody in ink' },
  { id: 'glass', label: 'Glass', note: 'translucent modules over a lit field' },
  { id: 'blueprint', label: 'Blueprint', note: 'cyanotype drafting sheet, line only' },
  { id: 'terminal', label: 'Terminal', note: 'one phosphor, one family, scanlines' },
  { id: 'floorplan', label: 'Floorplan', note: 'IC layout plot — macro cells on a dark die field' },
  { id: 'paper', label: 'Paper', note: 'white, hairline, almost nothing' },
] as const;

export type SkinId = (typeof SKINS)[number]['id'];

const STORAGE_KEY = 'iss.skin';
const DEFAULT: SkinId = 'record';

function isSkin(v: unknown): v is SkinId {
  return SKINS.some((s) => s.id === v);
}

export function loadSkin(): SkinId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isSkin(stored) ? stored : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function applySkin(skin: SkinId): void {
  document.documentElement.setAttribute('data-skin', skin);
  try {
    window.localStorage.setItem(STORAGE_KEY, skin);
  } catch {
    // A cosmetic preference is not worth failing a session over.
  }
}

/** Set the attribute before first paint so the app never flashes the wrong skin. */
export function initSkin(): SkinId {
  const skin = loadSkin();
  document.documentElement.setAttribute('data-skin', skin);
  return skin;
}
