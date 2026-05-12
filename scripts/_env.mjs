// Tiny .env loader so we don't pull in a dependency for one job. Reads KEY=VALUE
// lines from `.env` in the project root and copies any missing ones into
// process.env. Existing env vars (e.g. set by the GitHub Action) win.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export function loadEnv() {
    const here = dirname(fileURLToPath(import.meta.url));
    const envPath = resolve(here, '..', '.env');
    let raw;
    try {
        raw = readFileSync(envPath, 'utf8');
    } catch {
        return;   // no .env — fine, vars may come from the environment
    }
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        // Strip optional surrounding quotes.
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
