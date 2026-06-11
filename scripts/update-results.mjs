#!/usr/bin/env node
// Re-fetches all World Cup matches from football-data.org and updates scores,
// status, and (when known) team names in Supabase. Designed to run on a cron
// every hour during the tournament — see .github/workflows/update-results.yml.
//
// This script is intentionally the same shape as seed-fixtures.mjs; the only
// difference is that we also surface live and finished match counts in the log
// so the GitHub Action output tells you what happened.

import { createClient } from '@supabase/supabase-js';
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

function toRow(m) {
    return {
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
    };
}

const rows = matches.map(toRow);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
});

// football-data.org's free tier is served by inconsistent backends: the same
// request for a finished match randomly returns either the final score or a
// stale TIMED/null snapshot (observed 14 h after full time). So for matches
// that kicked off recently but lack a settled score, poll /v4/matches/{id} a
// few times and accept only a response that carries real information — a
// score, or a live status. A scoreless FINISHED is the stale node talking;
// writing it would put a "– : –" card in the results list.
const { data: existing, error: selectError } = await supabase
    .from('matches')
    .select('id, home_score, away_score, status');
if (selectError) {
    console.error('Supabase select failed:', selectError);
    process.exit(1);
}
const existingById = new Map((existing ?? []).map(r => [r.id, r]));

const isSettled = r => r != null && r.status === 'FINISHED' && r.home_score != null;
const now = Date.now();
const FETCH_WINDOW_MS = 4 * 24 * 3600 * 1000;
const MAX_SINGLE_FETCHES = 8;   // stay inside the 10 req/min free-tier budget

const stale = rows.filter(r => {
    const kickoff = new Date(r.utc_kickoff).getTime();
    return kickoff <= now && kickoff > now - FETCH_WINDOW_MS
        && !isSettled(r) && !isSettled(existingById.get(r.id));
});
if (stale.length > MAX_SINGLE_FETCHES) {
    console.warn(`${stale.length} matches need a single-match refetch; capping at ${MAX_SINGLE_FETCHES} this run.`);
}

const LIVE_STATUSES = new Set(['IN_PLAY', 'PAUSED', 'EXTRA_TIME', 'PENALTY_SHOOTOUT']);
const ATTEMPTS_PER_MATCH = 4;

const rowsById = new Map(rows.map(r => [r.id, r]));
let rateBudgetLeft = true;
for (const r of stale.slice(0, MAX_SINGLE_FETCHES)) {
    if (!rateBudgetLeft) break;
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MATCH; attempt++) {
        const singleRes = await fetchWithRetry(`https://api.football-data.org/v4/matches/${r.id}`, {
            headers: { 'X-Auth-Token': FOOTBALL_TOKEN },
        });
        if (parseInt(singleRes.headers.get('X-Requests-Available-Minute') ?? '99', 10) <= 2) {
            console.warn('Rate limit nearly exhausted — stopping single-match refetches for this run.');
            rateBudgetLeft = false;
        }
        if (!singleRes.ok) {
            console.warn(`Single-match fetch for ${r.id} returned ${singleRes.status} — keeping bulk data.`);
            break;
        }
        const body = await singleRes.json();
        const fresh = toRow(body.match ?? body);   // v4 returns the match at top level
        if (fresh.home_score != null || LIVE_STATUSES.has(fresh.status)) {
            rowsById.set(fresh.id, fresh);
            console.log(`Refetched ${fresh.home_team}–${fresh.away_team}: ${fresh.status} ${fresh.home_score ?? '–'}:${fresh.away_score ?? '–'} (attempt ${attempt})`);
            break;
        }
        console.log(`Refetch ${r.home_team}–${r.away_team} attempt ${attempt}: stale node (${fresh.status}, no score)`);
        if (!rateBudgetLeft) break;
        await new Promise(res => setTimeout(res, 700));
    }
}

// Never let the stale bulk snapshot wipe a score we already have.
const finalRows = [...rowsById.values()].map(r => {
    const db = existingById.get(r.id);
    if (isSettled(db) && r.home_score == null) {
        return { ...r, home_score: db.home_score, away_score: db.away_score, status: db.status };
    }
    return r;
});

const { error } = await supabase.from('matches').upsert(finalRows, { onConflict: 'id' });
if (error) {
    console.error('Supabase upsert failed:', error);
    process.exit(1);
}

const counts = finalRows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
}, {});
console.log(`Synced ${rows.length} matches. Status breakdown:`, counts);
