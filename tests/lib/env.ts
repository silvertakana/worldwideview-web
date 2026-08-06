/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';

/**
 * Env loading for the billing E2E suite.
 *
 * Playwright worker processes do NOT inherit env set in globalSetup, so each
 * spec reloads the hub's env files at module load time. This is the same
 * loadSingleEnv() pattern the suite used when it lived in the globe repo;
 * only the paths changed (cwd is now the hub repo root, not the globe).
 */
export function loadSingleEnv(envPath: string): void {
  try {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = (match[2] || '').trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        if (value) process.env[key] = value;
      }
    });
  } catch {
    // Ignore read errors
  }
}

/** Load the hub repo's env files (cwd = hub repo root for `pnpm test:e2e`). */
export function loadHubEnv(): void {
  loadSingleEnv(path.resolve(process.cwd(), '.env'));
  loadSingleEnv(path.resolve(process.cwd(), '.env.local'));
}
