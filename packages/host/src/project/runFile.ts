// Run-config persistence: <projectRoot>/iss_run.json. Pure fs — no vscode.

import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_RUN_CONFIG,
  normalizeRunConfig,
  type RunConfig,
} from '@iss/contracts/runConfig';

export function runConfigPath(projectRoot: string): string {
  return path.join(projectRoot, 'iss_run.json');
}

export function loadRunConfig(projectRoot: string): RunConfig {
  try {
    return normalizeRunConfig(JSON.parse(fs.readFileSync(runConfigPath(projectRoot), 'utf8')));
  } catch {
    return { ...DEFAULT_RUN_CONFIG, entries: [] };
  }
}

export function saveRunConfig(projectRoot: string, config: RunConfig): void {
  fs.writeFileSync(
    runConfigPath(projectRoot),
    JSON.stringify(normalizeRunConfig(config), null, 2) + '\n',
  );
}
