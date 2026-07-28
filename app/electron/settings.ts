// App-level settings — which projects you had open, and nothing else.
//
// Kept deliberately thin. Everything that describes a *design* already lives in
// that design's own directory (iss_layout.json, iss_spec.json, the run config),
// because a design is an on-disk project and not a database row. What belongs
// here is only what spans projects: the recent list.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

const MAX_RECENTS = 8;

export interface Settings {
  recents: string[];
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'iss_app.json');
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>;
    const recents = Array.isArray(raw.recents) ? raw.recents.filter((r) => typeof r === 'string') : [];
    return { recents };
  } catch {
    return { recents: [] };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    // Losing the recent list is not worth interrupting the session over.
  }
}

/** Most recent first, no duplicates, bounded. */
export function rememberProject(settings: Settings, dir: string): Settings {
  return {
    ...settings,
    recents: [dir, ...settings.recents.filter((r) => r !== dir)].slice(0, MAX_RECENTS),
  };
}
