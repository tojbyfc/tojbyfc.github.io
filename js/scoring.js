// Scoring rules:
//   correct 1X2 sign        =  1 point
//   correct exact score     = +3 points  (stacks with the sign point, total 4)
//   correct champion (gold) =  5 points
//   correct runner-up       =  5 points
//   correct top scorer      =  5 points

export const POINTS = {
    SIGN: 1,
    EXACT: 3,
    CHAMPION: 5,
    RUNNER_UP: 5,
    TOP_SCORER: 5,
};

export function signFromScore(home, away) {
    if (home > away) return '1';
    if (home < away) return '2';
    return 'X';
}

// Returns 0/1/4 for a single match bet given the finished match.
// Exact-score guesses always have the right sign, so they get SIGN + EXACT.
export function scoreMatchBet(bet, match) {
    if (match.home_score == null || match.away_score == null) return 0;
    if (match.status !== 'FINISHED') return 0;
    const actualSign = signFromScore(match.home_score, match.away_score);
    const signRight = bet.sign === actualSign;
    const exactRight = bet.home_score === match.home_score && bet.away_score === match.away_score;
    if (exactRight) return POINTS.SIGN + POINTS.EXACT;
    return signRight ? POINTS.SIGN : 0;
}

// Returns an array of { username, player, total, matchPoints, bonusPoints, exactCount, signCount }
// sorted by total desc, then exactCount desc, then signCount desc.
// `player` is the human-readable display_name (falls back to username if a
// submitted bet somehow lacks one — shouldn't happen since submit requires it).
export function computeStandings({ matches, matchBets, bonusBets, settings }) {
    const matchesById = new Map(matches.map(m => [m.id, m]));
    const tally = new Map(); // username → { display, total, matchPoints, bonusPoints, exactCount, signCount }

    function bucket(username, display) {
        if (!tally.has(username)) {
            tally.set(username, { display: display || username, total: 0, matchPoints: 0, bonusPoints: 0, exactCount: 0, signCount: 0 });
        } else if (display && tally.get(username).display === username) {
            tally.get(username).display = display;
        }
        return tally.get(username);
    }

    for (const bet of matchBets) {
        const match = matchesById.get(bet.match_id);
        if (!match) continue;
        const pts = scoreMatchBet(bet, match);
        const b = bucket(bet.username, bet.display_name);
        b.matchPoints += pts;
        b.total += pts;
        // An exact hit includes the correct sign, so it ticks both columns.
        if (pts === POINTS.SIGN + POINTS.EXACT) b.exactCount += 1;
        if (pts >= POINTS.SIGN) b.signCount += 1;
    }

    for (const bb of bonusBets) {
        const b = bucket(bb.username, bb.display_name);
        if (settings?.champion && bb.champion && bb.champion === settings.champion) {
            b.bonusPoints += POINTS.CHAMPION;
            b.total += POINTS.CHAMPION;
        }
        if (settings?.runner_up && bb.runner_up && bb.runner_up === settings.runner_up) {
            b.bonusPoints += POINTS.RUNNER_UP;
            b.total += POINTS.RUNNER_UP;
        }
        if (settings?.top_scorer && bb.top_scorer && bb.top_scorer === settings.top_scorer) {
            b.bonusPoints += POINTS.TOP_SCORER;
            b.total += POINTS.TOP_SCORER;
        }
    }

    return [...tally.entries()]
        .map(([username, s]) => ({ username, player: s.display, ...s }))
        .sort((a, b) => b.total - a.total || b.exactCount - a.exactCount || b.signCount - a.signCount);
}
