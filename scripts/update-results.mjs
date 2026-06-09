#!/usr/bin/env node
// Re-fetches all World Cup matches from football-data.org and updates scores,
// status, and (when known) team names in Supabase. Designed to run on a cron
// every hour during the tournament — see .github/workflows/update-results.yml.
//
// This script is intentionally the same shape as seed-fixtures.mjs; the only
// difference is that we also surface live and finished match counts in the log
// so the GitHub Action output tells you what happened.

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { loadEnv } from './_env.mjs';
loadEnv();

const FOOTBALL_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!FOOTBALL_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing FOOTBALL_DATA_TOKEN, SUPABASE_URL, or SUPABASE_SERVICE_KEY');
    process.exit(1);
}

const COMPETITION = 'WC';

// football-data.org occasionally drops the TLS connection mid-handshake
// (UND_ERR_SOCKET "other side closed"). On an hourly cron a single blip
// shouldn't fail the whole run, so retry transient network errors with backoff.
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
const { matches } = await res.json();

function logRateLimit(response) {
    const remaining = response.headers.get('X-Requests-Available-Minute');
    const reset = response.headers.get('X-RequestCounter-Reset');
    if (remaining != null) {
        const warn = parseInt(remaining, 10) <= 2 ? '  ⚠ low' : '';
        console.log(`Rate limit: ${remaining} requests left this minute (resets in ${reset ?? '?'}s)${warn}`);
    }
}

const rows = matches.map(m => ({
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
    realtime: { transport: WebSocket },   // Node < 22 has no native WebSocket
});

const { error } = await supabase.from('matches').upsert(rows, { onConflict: 'id' });
if (error) {
    console.error('Supabase upsert failed:', error);
    process.exit(1);
}

const counts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
}, {});
console.log(`Synced ${rows.length} matches. Status breakdown:`, counts);
