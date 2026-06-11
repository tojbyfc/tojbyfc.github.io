import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
});

export async function loadSettings() {
    const { data, error } = await supabase
        .from('public_settings')
        .select('deadline, top_scorer, champion, runner_up')
        .single();
    if (error) throw error;
    return data;
}

export async function loadMatches() {
    const { data, error } = await supabase
        .from('matches')
        .select('*')
        .order('utc_kickoff', { ascending: true });
    if (error) throw error;
    return data ?? [];
}

// Draft bets are hidden by RLS, so a player's own bets (drafts included) are
// fetched through the password-checked get_my_bets() RPC instead of plain
// selects.
export async function loadBetsForPlayer({ username, password }) {
    const { data, error } = await supabase.rpc('get_my_bets', {
        p_password: password,
        p_username: username,
    });
    if (error) throw error;
    return {
        matchBets: data?.match_bets ?? [],
        bonusBet: data?.bonus_bet ?? null,
        displayName: data?.display_name ?? null,
    };
}

// PostgREST caps every response at 1000 rows; with 27 players × 72 matches the
// bets table blows past that, so page through with .range() until a short page.
// The order() columns make pagination deterministic.
async function fetchAllRows(table, select, orderCols) {
    const PAGE = 1000;
    const all = [];
    for (let from = 0; ; from += PAGE) {
        let q = supabase.from(table).select(select).eq('is_submitted', true).range(from, from + PAGE - 1);
        for (const col of orderCols) q = q.order(col, { ascending: true });
        const { data, error } = await q;
        if (error) throw error;
        all.push(...(data ?? []));
        if (!data || data.length < PAGE) return all;
    }
}

export async function loadAllBets() {
    // Public standings see *submitted* bets only, and RLS additionally hides
    // everything until the deadline has passed — before that this returns
    // empty. The .eq filter is kept as an explicit statement of intent.
    // We join `players` so each bet carries the human-readable display_name —
    // the standings group by username but render display_name.
    const [matchBets, bonusBets] = await Promise.all([
        fetchAllRows('bets', '*, players(display_name)', ['username', 'match_id']),
        fetchAllRows('bonus_bets', '*, players(display_name)', ['username']),
    ]);
    const flatten = (rows) => rows.map(r => ({
        ...r,
        display_name: r.players?.display_name ?? null,
        players: undefined,
    }));
    return { matchBets: flatten(matchBets), bonusBets: flatten(bonusBets) };
}

// Pre-deadline participant list: who has submitted, without their picks.
// Fails soft (empty list) so a missing view — schema not yet re-run — degrades
// to "nobody yet" instead of an error banner.
export async function loadSubmittedPlayers() {
    const { data, error } = await supabase
        .from('submitted_players')
        .select('username, display_name')
        .order('display_name');
    if (error) {
        console.warn('loadSubmittedPlayers failed:', error);
        return [];
    }
    return data ?? [];
}

// The players table is publicly readable, so login can warn when a username
// doesn't exist yet — catches typos before they create a duplicate player.
export async function playerExists(username) {
    const { data, error } = await supabase
        .from('players')
        .select('username')
        .eq('username', username)
        .maybeSingle();
    if (error) throw error;
    return data !== null;
}

export async function verifyPassword(password) {
    const { data, error } = await supabase.rpc('verify_team_password', { supplied: password });
    if (error) throw error;
    return data === true;
}

export async function setDisplayName({ password, username, displayName }) {
    const { error } = await supabase.rpc('set_display_name', {
        p_password: password,
        p_username: username,
        p_display_name: displayName,
    });
    if (error) throw error;
}

export async function submitBet({ password, username, matchId, sign, homeScore, awayScore }) {
    const { error } = await supabase.rpc('submit_bet', {
        p_password: password,
        p_username: username,
        p_match_id: matchId,
        p_sign: sign,
        p_home_score: homeScore,
        p_away_score: awayScore,
    });
    if (error) throw error;
}

export async function deletePlayer({ password, username }) {
    const { error } = await supabase.rpc('delete_player', {
        p_password: password,
        p_username: username,
    });
    if (error) throw error;
}

export async function submitBonusBet({ password, username, champion, runnerUp, topScorer }) {
    const { error } = await supabase.rpc('submit_bonus_bet', {
        p_password: password,
        p_username: username,
        p_champion: champion,
        p_runner_up: runnerUp,
        p_top_scorer: topScorer,
    });
    if (error) throw error;
}

// Publish all of this player's draft bets to the public standings.
export async function submitAllBets({ password, username }) {
    const { error } = await supabase.rpc('submit_all_bets', {
        p_password: password,
        p_username: username,
    });
    if (error) throw error;
}
