import {
    loadSettings,
    loadMatches,
    loadAllBets,
    loadBetsForPlayer,
    verifyPassword,
    submitBet,
    submitBonusBet,
    submitAllBets,
    deletePlayer,
} from './supabase-client.js';
import { computeStandings, scoreMatchBet, signFromScore } from './scoring.js';

const SESSION_KEY = 'wcbet.session.v1';

// =============================================================================
// State
// =============================================================================
const state = {
    settings: null,
    matches: [],
    players: [],   // tournament squads, loaded from data/players.json
    allBets: { matchBets: [], bonusBets: [] },
    myBets: { matchBets: [], bonusBet: null },
    session: loadSession(),
};

function loadSession() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function saveSession(s) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    state.session = s;
}

function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    state.session = null;
}

function isLocked() {
    return state.settings && new Date() >= new Date(state.settings.deadline);
}

async function loadPlayers() {
    try {
        const res = await fetch('data/players.json', { cache: 'no-cache' });
        if (!res.ok) return [];
        return await res.json();
    } catch {
        return [];
    }
}

function teamOptions() {
    const set = new Set();
    for (const m of state.matches) {
        if (m.home_team && m.home_team !== 'TBD') set.add(m.home_team);
        if (m.away_team && m.away_team !== 'TBD') set.add(m.away_team);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
}

function playerOptions() {
    return state.players.map(p => ({
        label: p.name,
        value: p.name,
        hint: `${p.nationality} · ${p.position}`,
        search: `${p.name} ${p.nationality}`.toLowerCase(),
    }));
}

// Turns a text input into a typeahead dropdown. `getOptions()` is evaluated
// lazily on every interaction so the menu reflects the current state. Each
// option may be a plain string OR an object `{ label, value, hint?, search? }`
// — strings are the simple team case, objects are used for players where we
// want to show nationality / position as muted hint text.
function attachSearchSelect(input, getOptions, { maxResults = 50 } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'search-select-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');

    const list = document.createElement('div');
    list.className = 'search-options';
    list.hidden = true;
    list.setAttribute('role', 'listbox');
    wrap.appendChild(list);

    let activeIndex = -1;
    let currentFiltered = [];

    function normalize(opts) {
        return opts.map(o => typeof o === 'string'
            ? { label: o, value: o, search: o.toLowerCase() }
            : { label: o.label, value: o.value, hint: o.hint, search: (o.search ?? o.label).toLowerCase() }
        );
    }

    function render() {
        const all = normalize(getOptions());
        const q = input.value.toLowerCase().trim();
        const matching = q ? all.filter(o => o.search.includes(q)) : all;
        const truncated = matching.length > maxResults;
        currentFiltered = matching.slice(0, maxResults);

        list.innerHTML = '';
        if (matching.length === 0) {
            list.hidden = true;
            return;
        }
        currentFiltered.forEach((opt, i) => {
            const item = document.createElement('div');
            item.className = 'search-option' + (i === activeIndex ? ' active' : '');
            item.setAttribute('role', 'option');

            let labelHtml;
            if (q) {
                const idx = opt.label.toLowerCase().indexOf(q);
                labelHtml = idx >= 0
                    ? escapeHtml(opt.label.slice(0, idx)) +
                      '<strong>' + escapeHtml(opt.label.slice(idx, idx + q.length)) + '</strong>' +
                      escapeHtml(opt.label.slice(idx + q.length))
                    : escapeHtml(opt.label);
            } else {
                labelHtml = escapeHtml(opt.label);
            }
            item.innerHTML = opt.hint
                ? `<span class="search-option-label">${labelHtml}</span><span class="search-option-hint">${escapeHtml(opt.hint)}</span>`
                : labelHtml;

            item.addEventListener('mousedown', (e) => {
                e.preventDefault();   // keep focus on the input
                select(opt.value);
            });
            list.appendChild(item);
        });

        if (truncated) {
            const more = document.createElement('div');
            more.className = 'search-options-more';
            more.textContent = `+${matching.length - maxResults} till — fortsätt skriva för att smalna av`;
            list.appendChild(more);
        }
        list.hidden = false;
    }

    function select(value) {
        input.value = value;
        list.hidden = true;
        activeIndex = -1;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    input.addEventListener('focus', () => { activeIndex = -1; render(); });
    input.addEventListener('input', () => { activeIndex = -1; render(); });
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
    input.addEventListener('keydown', (e) => {
        if (list.hidden) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, currentFiltered.length - 1);
            render();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            render();
        } else if (e.key === 'Enter' && activeIndex >= 0) {
            e.preventDefault();
            select(currentFiltered[activeIndex].value);
        } else if (e.key === 'Escape') {
            list.hidden = true;
        }
    });
}

let searchSelectsAttached = false;
function attachTeamSearchSelects() {
    if (searchSelectsAttached) return;
    searchSelectsAttached = true;
    attachSearchSelect(document.getElementById('bonus-champion'), teamOptions);
    attachSearchSelect(document.getElementById('bonus-runner-up'), teamOptions);
    attachSearchSelect(document.getElementById('bonus-top-scorer'), playerOptions);
}

// =============================================================================
// Boot
// =============================================================================
(async function init() {
    // Each query is independent — one failing (e.g. a missing `is_submitted`
    // column before the new schema migration is applied) must not blank out
    // the rest of the page.
    const results = await Promise.allSettled([
        loadSettings(),
        loadMatches(),
        loadAllBets(),
        loadPlayers(),
    ]);
    const [settingsR, matchesR, allBetsR, playersR] = results;
    const failures = [];
    if (settingsR.status === 'fulfilled') state.settings = settingsR.value;
    else failures.push(['settings', settingsR.reason]);
    if (matchesR.status === 'fulfilled') state.matches = matchesR.value;
    else failures.push(['matches', matchesR.reason]);
    if (allBetsR.status === 'fulfilled') state.allBets = allBetsR.value;
    else failures.push(['allBets', allBetsR.reason]);
    if (playersR.status === 'fulfilled') state.players = playersR.value;
    else failures.push(['players', playersR.reason]);

    if (state.session?.name) {
        try {
            state.myBets = await loadBetsForPlayer(state.session.name);
        } catch (err) {
            failures.push(['myBets', err]);
        }
    }

    attachTeamSearchSelects();
    renderAll();
    startCountdown();
    setInterval(refreshLive, 60_000);

    if (failures.length > 0) {
        for (const [name, err] of failures) console.error(`[init] ${name} failed:`, err);
        const banner = document.getElementById('boot-error');
        banner.textContent =
            'Vissa data kunde inte laddas (' + failures.map(f => f[0]).join(', ') +
            '). Har du kört senaste supabase/schema.sql i Supabase? Se konsolen för detaljer.';
        banner.style.display = 'block';
    }
})();

async function refreshLive() {
    try {
        const [matches, allBets] = await Promise.all([loadMatches(), loadAllBets()]);
        state.matches = matches;
        state.allBets = allBets;
        renderStandings();
        renderResults();
    } catch (err) {
        console.warn('Background refresh failed:', err);
    }
}

// =============================================================================
// Render
// =============================================================================
function renderAll() {
    renderSession();
    renderDeadline();
    renderBetForm();
    renderSubmitStatus();
    renderStandings();
    renderResults();
}

function renderSession() {
    const banner = document.getElementById('session-banner');
    const loginCard = document.getElementById('login-card');
    if (state.session?.name) {
        banner.style.display = 'flex';
        banner.querySelector('.session-name').textContent = state.session.name;
        loginCard.style.display = 'none';
    } else {
        banner.style.display = 'none';
        loginCard.style.display = 'block';
    }
}

function renderDeadline() {
    const el = document.getElementById('deadline-text');
    if (!state.settings) { el.textContent = ''; return; }
    const d = new Date(state.settings.deadline);
    el.textContent = d.toLocaleString('sv-SE', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function startCountdown() {
    const el = document.getElementById('countdown');
    function tick() {
        if (!state.settings) return;
        const ms = new Date(state.settings.deadline) - new Date();
        if (ms <= 0) {
            el.textContent = 'Tippningen är låst';
            el.classList.add('locked');
            return;
        }
        const days = Math.floor(ms / 86_400_000);
        const hours = Math.floor((ms % 86_400_000) / 3_600_000);
        const minutes = Math.floor((ms % 3_600_000) / 60_000);
        const seconds = Math.floor((ms % 60_000) / 1000);
        el.innerHTML = `
            <span><strong>${days}</strong><small>d</small></span>
            <span><strong>${String(hours).padStart(2, '0')}</strong><small>tim</small></span>
            <span><strong>${String(minutes).padStart(2, '0')}</strong><small>min</small></span>
            <span><strong>${String(seconds).padStart(2, '0')}</strong><small>s</small></span>
        `;
    }
    tick();
    setInterval(tick, 1000);
}

function groupMatchesByDate(matches) {
    const groups = new Map();
    for (const m of matches) {
        const key = new Date(m.utc_kickoff).toLocaleDateString('sv-SE', {
            weekday: 'long', month: 'long', day: 'numeric',
        });
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
    }
    return [...groups.entries()];
}

function renderBetForm() {
    const card = document.getElementById('bet-form-card');
    const lockedBanner = document.getElementById('lock-banner');

    if (!state.session?.name) {
        card.style.display = 'none';
        return;
    }
    card.style.display = 'block';

    if (isLocked()) {
        lockedBanner.style.display = 'block';
    } else {
        lockedBanner.style.display = 'none';
    }

    const myBetsById = new Map(state.myBets.matchBets.map(b => [b.match_id, b]));
    const container = document.getElementById('match-bets');
    container.innerHTML = '';

    // Knockout fixtures are 'TBD vs TBD' until the bracket is set, which
    // happens after the betting deadline. Hide them — they can't be bet on.
    const bettable = state.matches.filter(m => m.home_team !== 'TBD' && m.away_team !== 'TBD');
    const grouped = groupMatchesByDate(bettable);
    for (const [date, matches] of grouped) {
        const day = document.createElement('div');
        day.className = 'match-day';
        day.innerHTML = `<h3>${escapeHtml(date)}</h3>`;
        for (const m of matches) {
            day.appendChild(renderMatchRow(m, myBetsById.get(m.id)));
        }
        container.appendChild(day);
    }

    // Bonus picks
    const bonus = state.myBets.bonusBet || {};
    document.getElementById('bonus-champion').value = bonus.champion ?? '';
    document.getElementById('bonus-runner-up').value = bonus.runner_up ?? '';
    document.getElementById('bonus-top-scorer').value = bonus.top_scorer ?? '';

    const locked = isLocked();
    for (const el of document.querySelectorAll('#bet-form-card input, #bet-form-card select, #bet-form-card button')) {
        el.disabled = locked;
    }
}

function renderMatchRow(match, bet) {
    const row = document.createElement('div');
    row.className = 'match-row';
    row.dataset.matchId = match.id;

    const kickoff = new Date(match.utc_kickoff).toLocaleTimeString('sv-SE', {
        hour: '2-digit', minute: '2-digit',
    });
    const matchStarted = new Date() >= new Date(match.utc_kickoff);

    row.innerHTML = `
        <div class="match-time">${escapeHtml(kickoff)}${match.group_name ? ` · Grupp ${escapeHtml(match.group_name)}` : ''}</div>
        <div class="match-teams">
            <span class="team home">${escapeHtml(match.home_team)}</span>
            <span class="vs">vs</span>
            <span class="team away">${escapeHtml(match.away_team)}</span>
        </div>
        <div class="match-inputs">
            <input type="number" min="0" max="20" class="score home-score" placeholder="—" value="${bet?.home_score ?? ''}">
            <span class="dash">–</span>
            <input type="number" min="0" max="20" class="score away-score" placeholder="—" value="${bet?.away_score ?? ''}">
            <select class="sign">
                <option value="">1X2</option>
                <option value="1" ${bet?.sign === '1' ? 'selected' : ''}>1</option>
                <option value="X" ${bet?.sign === 'X' ? 'selected' : ''}>X</option>
                <option value="2" ${bet?.sign === '2' ? 'selected' : ''}>2</option>
            </select>
            <span class="save-status"></span>
        </div>
    `;

    const home = row.querySelector('.home-score');
    const away = row.querySelector('.away-score');
    const sign = row.querySelector('.sign');
    const status = row.querySelector('.save-status');

    function autoSign() {
        const h = parseInt(home.value, 10);
        const a = parseInt(away.value, 10);
        if (!Number.isNaN(h) && !Number.isNaN(a)) {
            sign.value = signFromScore(h, a);
        }
    }
    home.addEventListener('input', autoSign);
    away.addEventListener('input', autoSign);

    const debouncedSave = debounce(async () => {
        const h = parseInt(home.value, 10);
        const a = parseInt(away.value, 10);
        const s = sign.value;
        if (Number.isNaN(h) || Number.isNaN(a) || !s) return;
        status.textContent = 'sparar…';
        status.className = 'save-status saving';
        try {
            await submitBet({
                password: state.session.password,
                playerName: state.session.name,
                matchId: match.id,
                sign: s,
                homeScore: h,
                awayScore: a,
            });
            status.textContent = '✓ sparad (utkast)';
            status.className = 'save-status saved';
            // Update local cache so re-renders keep the value. Autosaves are
            // always drafts — they only become visible to others after submit.
            const idx = state.myBets.matchBets.findIndex(b => b.match_id === match.id);
            const rec = { player_name: state.session.name, match_id: match.id, sign: s, home_score: h, away_score: a, is_submitted: false };
            if (idx === -1) state.myBets.matchBets.push(rec);
            else state.myBets.matchBets[idx] = rec;
            renderSubmitStatus();
        } catch (err) {
            status.textContent = '⚠ ' + (err.message || 'sparning misslyckades');
            status.className = 'save-status error';
        }
    }, 700);

    for (const el of [home, away, sign]) {
        el.addEventListener('change', debouncedSave);
        el.addEventListener('input', debouncedSave);
    }

    // Visual hint that the match has already started — bet is in stone now.
    if (matchStarted) row.classList.add('match-started');

    return row;
}

function renderStandings() {
    const tbody = document.getElementById('standings-body');
    tbody.innerHTML = '';
    const standings = computeStandings({
        matches: state.matches,
        matchBets: state.allBets.matchBets,
        bonusBets: state.allBets.bonusBets,
        settings: state.settings,
    });
    if (standings.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="muted">Inga tips lagda ännu.</td></tr>';
        return;
    }
    for (let i = 0; i < standings.length; i++) {
        const s = standings[i];
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="rank">${i + 1}</td>
            <td>${escapeHtml(s.player)}</td>
            <td class="num">${s.exactCount}</td>
            <td class="num">${s.signCount}</td>
            <td class="num total">${s.total}</td>
        `;
        tbody.appendChild(tr);
    }
}

// =============================================================================
// Delete my own bets — popover anchored to the "Ta bort mina tips" button.
// =============================================================================
const deletePopover = document.getElementById('delete-popover');
const deleteErrorEl = document.getElementById('delete-error');
const deleteConfirmBtn = document.getElementById('delete-confirm');
const deleteMyBetsBtn = document.getElementById('delete-my-bets');

function openDeletePopover() {
    if (!state.session?.name) return;
    document.getElementById('delete-target-name').textContent = state.session.name;
    deleteErrorEl.textContent = '';
    deleteConfirmBtn.disabled = false;
    deletePopover.hidden = false;
    setTimeout(() => {
        document.addEventListener('click', handleDeleteOutsideClick);
        document.addEventListener('keydown', handleDeleteEscapeKey);
    }, 0);
}

function closeDeletePopover() {
    deletePopover.hidden = true;
    document.removeEventListener('click', handleDeleteOutsideClick);
    document.removeEventListener('keydown', handleDeleteEscapeKey);
}

function handleDeleteOutsideClick(e) {
    if (deletePopover.contains(e.target) || e.target === deleteMyBetsBtn) return;
    closeDeletePopover();
}

function handleDeleteEscapeKey(e) {
    if (e.key === 'Escape') closeDeletePopover();
}

deleteMyBetsBtn.addEventListener('click', (e) => {
    if (deletePopover.hidden) {
        e.stopPropagation();
        openDeletePopover();
    } else {
        closeDeletePopover();
    }
});

document.getElementById('delete-cancel').addEventListener('click', () => {
    closeDeletePopover();
});

deleteConfirmBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!state.session?.name) return;
    deleteErrorEl.textContent = '';
    deleteConfirmBtn.disabled = true;
    try {
        await deletePlayer({
            password: state.session.password,
            playerName: state.session.name,
        });
        clearSession();
        state.myBets = { matchBets: [], bonusBet: null };
        state.allBets = await loadAllBets();
        closeDeletePopover();
        renderAll();
    } catch (err) {
        deleteErrorEl.textContent = err.message || 'Kunde inte ta bort tipsen.';
        deleteConfirmBtn.disabled = false;
    }
});

function renderResults() {
    const container = document.getElementById('results-list');
    container.innerHTML = '';
    const finished = state.matches.filter(m => m.status === 'FINISHED' || m.status === 'IN_PLAY');
    if (finished.length === 0) {
        container.innerHTML = '<p class="muted">Inga matcher spelade ännu.</p>';
        return;
    }
    // Most recent first.
    finished.sort((a, b) => new Date(b.utc_kickoff) - new Date(a.utc_kickoff));

    for (const m of finished.slice(0, 12)) {
        const card = document.createElement('div');
        card.className = 'result-card';
        const date = new Date(m.utc_kickoff).toLocaleString('sv-SE', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const live = m.status === 'IN_PLAY';
        card.innerHTML = `
            <div class="result-meta">
                ${escapeHtml(date)}${m.group_name ? ' · Grupp ' + escapeHtml(m.group_name) : ''}
                ${live ? '<span class="live-pill">DIREKT</span>' : ''}
            </div>
            <div class="result-teams">
                <span class="team">${escapeHtml(m.home_team)}</span>
                <span class="score">${m.home_score ?? '–'} : ${m.away_score ?? '–'}</span>
                <span class="team">${escapeHtml(m.away_team)}</span>
            </div>
        `;
        container.appendChild(card);
    }
}

// =============================================================================
// Login / logout
// =============================================================================
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('login-name').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Vänligen ange ditt namn.'; return; }
    try {
        const ok = await verifyPassword(password);
        if (!ok) { errEl.textContent = 'Fel lösenord.'; return; }
        saveSession({ name, password });
        state.myBets = await loadBetsForPlayer(name);
        renderAll();
    } catch (err) {
        errEl.textContent = err.message || 'Inloggning misslyckades.';
    }
});

document.getElementById('logout').addEventListener('click', () => {
    clearSession();
    state.myBets = { matchBets: [], bonusBet: null };
    renderAll();
});

// =============================================================================
// Bonus picks autosave (drafts, same model as match bets)
// =============================================================================
const debouncedBonusSave = debounce(async () => {
    if (!state.session?.name) return;
    const status = document.getElementById('bonus-status');
    const champion = document.getElementById('bonus-champion').value.trim();
    const runnerUp = document.getElementById('bonus-runner-up').value.trim();
    const topScorer = document.getElementById('bonus-top-scorer').value.trim();
    status.textContent = 'sparar…';
    status.className = 'save-status saving';
    try {
        await submitBonusBet({
            password: state.session.password,
            playerName: state.session.name,
            champion, runnerUp, topScorer,
        });
        status.textContent = '✓ sparad (utkast)';
        status.className = 'save-status saved';
        state.myBets.bonusBet = {
            player_name: state.session.name,
            champion: champion || null,
            runner_up: runnerUp || null,
            top_scorer: topScorer || null,
            is_submitted: false,
        };
        renderSubmitStatus();
    } catch (err) {
        status.textContent = '⚠ ' + (err.message || 'sparning misslyckades');
        status.className = 'save-status error';
    }
}, 700);

for (const id of ['bonus-champion', 'bonus-runner-up', 'bonus-top-scorer']) {
    const el = document.getElementById(id);
    el.addEventListener('change', debouncedBonusSave);
    el.addEventListener('input', debouncedBonusSave);
}

// =============================================================================
// Submit all bets — publishes drafts to the public standings.
// =============================================================================
const submitPopover = document.getElementById('submit-popover');
const submitErrorEl = document.getElementById('submit-error');
const submitConfirmBtn = document.getElementById('submit-confirm');
const submitAllBtn = document.getElementById('submit-all');

function openSubmitPopover() {
    submitErrorEl.textContent = '';
    submitConfirmBtn.disabled = false;
    submitPopover.hidden = false;
    // Defer so the click that opened the popover doesn't immediately close it.
    setTimeout(() => {
        document.addEventListener('click', handleOutsideClick);
        document.addEventListener('keydown', handleEscapeKey);
    }, 0);
}

function closeSubmitPopover() {
    submitPopover.hidden = true;
    document.removeEventListener('click', handleOutsideClick);
    document.removeEventListener('keydown', handleEscapeKey);
}

function handleOutsideClick(e) {
    if (submitPopover.contains(e.target) || e.target === submitAllBtn) return;
    closeSubmitPopover();
}

function handleEscapeKey(e) {
    if (e.key === 'Escape') closeSubmitPopover();
}

function countUnsubmittedDrafts() {
    let n = 0;
    for (const b of state.myBets.matchBets) if (b.is_submitted === false) n += 1;
    if (state.myBets.bonusBet && state.myBets.bonusBet.is_submitted === false) n += 1;
    return n;
}

function renderSubmitStatus() {
    const statusEl = document.getElementById('submit-status');
    const btn = document.getElementById('submit-all');
    if (!statusEl || !btn) return;
    if (isLocked()) {
        statusEl.textContent = 'Tippningen är låst.';
        statusEl.className = 'submit-status';
        btn.disabled = true;
        return;
    }
    const drafts = countUnsubmittedDrafts();
    const totalBets = state.myBets.matchBets.length + (state.myBets.bonusBet ? 1 : 0);
    if (totalBets === 0) {
        statusEl.textContent = 'Du har inga tips ännu — börja fyll i ovan så sparas de automatiskt.';
        statusEl.className = 'submit-status';
        btn.disabled = true;
        return;
    }
    if (drafts === 0) {
        statusEl.textContent = '✓ Alla dina tips är inskickade och synliga för alla.';
        statusEl.className = 'submit-status clean';
        btn.disabled = false;   // re-submission allowed even when clean
        return;
    }
    statusEl.textContent = `${drafts} osända ${drafts === 1 ? 'ändring' : 'ändringar'} — bara du ser dem just nu.`;
    statusEl.className = 'submit-status dirty';
    btn.disabled = false;
}

submitAllBtn.addEventListener('click', (e) => {
    if (!state.session?.name || isLocked()) return;
    if (submitPopover.hidden) {
        e.stopPropagation();   // outside-click listener attaches in openSubmitPopover
        openSubmitPopover();
    } else {
        closeSubmitPopover();
    }
});

document.getElementById('submit-cancel').addEventListener('click', () => {
    closeSubmitPopover();
});

submitConfirmBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!state.session?.name) return;
    submitErrorEl.textContent = '';
    submitConfirmBtn.disabled = true;
    const statusEl = document.getElementById('submit-status');
    statusEl.textContent = 'skickar in…';
    statusEl.className = 'submit-status saving';
    try {
        await submitAllBets({
            password: state.session.password,
            playerName: state.session.name,
        });
        // Flip local draft flags so the UI reflects the new published state.
        for (const b of state.myBets.matchBets) b.is_submitted = true;
        if (state.myBets.bonusBet) state.myBets.bonusBet.is_submitted = true;
        closeSubmitPopover();
        // Refresh public standings so the player sees their bets appear there.
        state.allBets = await loadAllBets();
        renderSubmitStatus();
        renderStandings();
    } catch (err) {
        submitErrorEl.textContent = err.message || 'Kunde inte skicka in tipsen.';
        submitConfirmBtn.disabled = false;
        renderSubmitStatus();
    }
});

// =============================================================================
// Utilities
// =============================================================================
function debounce(fn, ms) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
