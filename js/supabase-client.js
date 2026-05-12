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

export async function loadBetsForPlayer(name) {
    const [matchBets, bonusBet] = await Promise.all([
        supabase.from('bets').select('*').eq('player_name', name),
        supabase.from('bonus_bets').select('*').eq('player_name', name).maybeSingle(),
    ]);
    if (matchBets.error) throw matchBets.error;
    if (bonusBet.error) throw bonusBet.error;
    return { matchBets: matchBets.data ?? [], bonusBet: bonusBet.data };
}

export async function loadAllBets() {
    // Public standings see *submitted* bets only. Drafts (autosaved-but-not-yet-
    // submitted) stay private to their owner until they click "Submit my bets".
    // If the `is_submitted` column isn't there yet (schema hasn't been migrated),
    // we silently fall back to returning every row — better than blanking the
    // whole page while the operator catches up.
    async function fetchPublic(table) {
        const filtered = await supabase.from(table).select('*').eq('is_submitted', true);
        if (!filtered.error) return filtered.data ?? [];
        if (filtered.error.code === '42703' /* undefined_column */) {
            const all = await supabase.from(table).select('*');
            if (all.error) throw all.error;
            return all.data ?? [];
        }
        throw filtered.error;
    }
    const [matchBets, bonusBets] = await Promise.all([
        fetchPublic('bets'),
        fetchPublic('bonus_bets'),
    ]);
    return { matchBets, bonusBets };
}

export async function verifyPassword(password) {
    const { data, error } = await supabase.rpc('verify_team_password', { supplied: password });
    if (error) throw error;
    return data === true;
}

export async function submitBet({ password, playerName, matchId, sign, homeScore, awayScore }) {
    const { error } = await supabase.rpc('submit_bet', {
        p_password: password,
        p_player_name: playerName,
        p_match_id: matchId,
        p_sign: sign,
        p_home_score: homeScore,
        p_away_score: awayScore,
    });
    if (error) throw error;
}

export async function deletePlayer({ password, playerName }) {
    const { error } = await supabase.rpc('delete_player', {
        p_password: password,
        p_player_name: playerName,
    });
    if (error) throw error;
}

export async function submitBonusBet({ password, playerName, champion, runnerUp, topScorer }) {
    const { error } = await supabase.rpc('submit_bonus_bet', {
        p_password: password,
        p_player_name: playerName,
        p_champion: champion,
        p_runner_up: runnerUp,
        p_top_scorer: topScorer,
    });
    if (error) throw error;
}

// Publish all of this player's draft bets to the public standings.
export async function submitAllBets({ password, playerName }) {
    const { error } = await supabase.rpc('submit_all_bets', {
        p_password: password,
        p_player_name: playerName,
    });
    if (error) throw error;
}
