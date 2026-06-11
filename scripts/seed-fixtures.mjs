#!/usr/bin/env node
// Fetches the World Cup fixture list AND every team's squad from football-data.org,
// upserts every match into the Supabase `matches` table, and writes the squad
// roster as `data/players.json` for the top-scorer dropdown in the frontend.
//
// Run once before the tournament, and any time the schedule changes (e.g.
// when knockout pairings are drawn) or squads are confirmed.
//
// Required env vars:
//   FOOTBALL_DATA_TOKEN  — free API key from https://www.football-data.org/
//   SUPABASE_URL         — https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY — service-role key (NOT the anon key) — keep secret
//
// Usage: node scripts/seed-fixtures.mjs

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnv } from './_env.mjs';
loadEnv();

const FOOTBALL_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!FOOTBALL_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing FOOTBALL_DATA_TOKEN, SUPABASE_URL, or SUPABASE_SERVICE_KEY');
    process.exit(1);
}

// football-data.org competition code for the FIFA World Cup.
const COMPETITION = 'WC';

// football-data.org occasionally drops the TLS connection mid-handshake
// (UND_ERR_SOCKET "other side closed"). Retry transient network errors with
// backoff so a single blip doesn't abort the seed.
async function fetchWithRetry(url, options, { retries = 4, baseDelayMs = 2000 } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fetch(url, options);
        } catch (err) {
            if (attempt >= retries) throw err;
            const delay = baseDelayMs * 2 ** attempt;
            console.warn(`fetch failed (attempt ${attempt + 1}/${retries + 1}): ${err.cause?.code ?? err.message}. Retrying in ${delay}ms…`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

const res = await fetchWithRetry(`https://api.football-data.org/v4/competitions/${COMPETITION}/matches`, {
    headers: { 'X-Auth-Token': FOOTBALL_TOKEN },
});
logRateLimit(res);
if (res.status === 429) {
    const reset = res.headers.get('X-RequestCounter-Reset') || '?';
    console.error(`Rate-limited by football-data.org. Try again in ${reset}s.`);
    process.exit(1);
}
if (!res.ok) {
    console.error(`football-data.org returned ${res.status}: ${await res.text()}`);
    process.exit(1);
}
const payload = await res.json();

function logRateLimit(response) {
    const remaining = response.headers.get('X-Requests-Available-Minute');
    const reset = response.headers.get('X-RequestCounter-Reset');
    if (remaining != null) {
        const warn = parseInt(remaining, 10) <= 2 ? '  ⚠ low' : '';
        console.log(`Rate limit: ${remaining} requests left this minute (resets in ${reset ?? '?'}s)${warn}`);
    }
}

const rows = payload.matches.map(m => ({
    id: m.id,
    utc_kickoff: m.utcDate,
    matchday: m.matchday,
    stage: m.stage,
    group_name: m.group ? m.group.replace(/^GROUP_/, '') : null,
    home_team: m.homeTeam?.name ?? 'TBD',
    away_team: m.awayTeam?.name ?? 'TBD',
    home_score: m.score?.fullTime?.home ?? null,
    away_score: m.score?.fullTime?.away ?? null,
    status: m.status,
    updated_at: new Date().toISOString(),
}));

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
});

const { error } = await supabase.from('matches').upsert(rows, { onConflict: 'id' });
if (error) {
    console.error('Supabase upsert failed:', error);
    process.exit(1);
}

console.log(`Upserted ${rows.length} matches.`);

// -----------------------------------------------------------------------------
// Squad roster → data/players.json (consumed by the top-scorer dropdown).
// -----------------------------------------------------------------------------

const teamsRes = await fetchWithRetry(`https://api.football-data.org/v4/competitions/${COMPETITION}/teams`, {
    headers: { 'X-Auth-Token': FOOTBALL_TOKEN },
});
logRateLimit(teamsRes);
if (!teamsRes.ok) {
    console.error(`football-data.org teams returned ${teamsRes.status}: ${await teamsRes.text()}`);
    process.exit(1);
}
const teamsPayload = await teamsRes.json();

const players = [];
for (const team of teamsPayload.teams ?? []) {
    for (const p of team.squad ?? []) {
        // Goalkeepers basically never win top-scorer titles. Keep the dropdown short.
        if (p.position === 'Goalkeeper') continue;
        players.push({
            name: p.name,
            nationality: p.nationality || team.name,
            position: p.position || 'Player',
        });
    }
}
players.sort((a, b) => a.name.localeCompare(b.name));

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '..', 'data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(resolve(dataDir, 'players.json'), JSON.stringify(players, null, 2));
console.log(`Wrote ${players.length} players to data/players.json.`);
