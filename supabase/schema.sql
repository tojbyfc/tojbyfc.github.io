-- World Cup 2026 betting — Supabase schema
-- Run this once in the Supabase SQL editor (Project → SQL → New query → paste → Run).
-- It is safe to re-run: every statement is idempotent.

create extension if not exists pgcrypto;

-- =============================================================================
-- Tables
-- =============================================================================

-- One row of global settings. Holds the shared team password (hashed) and the
-- bet-submission deadline. Edit values via the SQL editor after running this
-- script — see the "INITIAL SETUP" section at the bottom of this file.
create table if not exists settings (
    id              int primary key default 1,
    team_password   text not null,        -- bcrypt hash, never plaintext
    deadline        timestamptz not null, -- 1 hour before first match
    top_scorer      text,                 -- filled in after tournament
    champion        text,                 -- filled in after tournament
    runner_up       text,                 -- filled in after tournament
    constraint settings_singleton check (id = 1)
);

-- Matches (fixtures + results). Populated by scripts/seed-fixtures.mjs and
-- kept up to date by scripts/update-results.mjs.
create table if not exists matches (
    id              bigint primary key,         -- football-data.org match id
    utc_kickoff     timestamptz not null,
    matchday        int,
    stage           text,                       -- GROUP_STAGE, LAST_16, etc.
    group_name      text,                       -- 'A', 'B', ... (group stage only)
    home_team       text not null,
    away_team       text not null,
    home_score      int,                        -- null until full-time
    away_score      int,
    status          text not null default 'SCHEDULED',  -- SCHEDULED, IN_PLAY, FINISHED
    updated_at      timestamptz not null default now()
);

create index if not exists matches_kickoff_idx on matches (utc_kickoff);

-- Players. `username` is the stable login identifier (lowercased so logins are
-- case-insensitive). `display_name` is what shows up in the public standings
-- and can be edited any time before the deadline. It must be set before a
-- player is allowed to submit their bets.
create table if not exists players (
    username        text primary key,
    display_name    text,
    created_at      timestamptz not null default now()
);

-- Per-match bets.
--
-- `is_submitted` separates *draft* bets (autosaved as the player types, visible
-- only to themselves) from *submitted* bets (visible to everyone in the public
-- standings). Editing a bet flips it back to draft until the player re-submits.
create table if not exists bets (
    username        text not null references players(username) on delete cascade,
    match_id        bigint not null references matches(id) on delete cascade,
    sign            text not null check (sign in ('1', 'X', '2')),
    home_score      int not null check (home_score >= 0),
    away_score      int not null check (away_score >= 0),
    is_submitted    boolean not null default true,
    updated_at      timestamptz not null default now(),
    primary key (username, match_id)
);

-- Sanity cap on score predictions, matching the UI's max="20". Added via
-- drop/add so re-running this script upgrades existing databases too.
alter table bets drop constraint if exists bets_score_range;
alter table bets add constraint bets_score_range
    check (home_score between 0 and 20 and away_score between 0 and 20);

-- Tournament-wide bonus picks: champion, runner-up, top scorer.
create table if not exists bonus_bets (
    username        text primary key references players(username) on delete cascade,
    champion        text,
    runner_up       text,
    top_scorer      text,
    is_submitted    boolean not null default true,
    updated_at      timestamptz not null default now()
);

-- =============================================================================
-- Password verification + write RPCs
-- =============================================================================

create or replace function verify_team_password(supplied text)
returns boolean
language sql stable security definer
as $$
    select crypt(supplied, team_password) = team_password from settings where id = 1;
$$;

create or replace function deadline_passed()
returns boolean
language sql stable security definer
as $$
    select now() >= deadline from settings where id = 1;
$$;

-- Set or update the player's display name. Creates the player row if it
-- doesn't exist yet, so this can be the very first call after login. Username
-- is normalized to lowercase so logins are case-insensitive.
create or replace function set_display_name(
    p_password      text,
    p_username      text,
    p_display_name  text
) returns void
language plpgsql security definer
as $$
declare
    v_username  text := lower(trim(p_username));
    v_display   text := trim(p_display_name);
begin
    if not verify_team_password(p_password) then
        raise exception 'invalid team password';
    end if;
    if length(v_username) = 0 then
        raise exception 'username required';
    end if;
    if length(v_display) = 0 then
        raise exception 'display name required';
    end if;

    insert into players (username, display_name) values (v_username, v_display)
        on conflict (username) do update set display_name = excluded.display_name;
end;
$$;

-- Autosave a match bet as a *draft* (is_submitted = false). The bet is visible
-- only to the player themselves until they click "Submit my bets", which calls
-- submit_all_bets() to flip is_submitted to true. Fails if password is wrong
-- or the deadline has passed.
create or replace function submit_bet(
    p_password      text,
    p_username      text,
    p_match_id      bigint,
    p_sign          text,
    p_home_score    int,
    p_away_score    int
) returns void
language plpgsql security definer
as $$
declare
    v_username text := lower(trim(p_username));
begin
    if not verify_team_password(p_password) then
        raise exception 'invalid team password';
    end if;
    if deadline_passed() then
        raise exception 'betting deadline has passed';
    end if;
    if length(v_username) = 0 then
        raise exception 'username required';
    end if;

    insert into players (username) values (v_username)
        on conflict (username) do nothing;

    insert into bets (username, match_id, sign, home_score, away_score, is_submitted)
        values (v_username, p_match_id, p_sign, p_home_score, p_away_score, false)
        on conflict (username, match_id) do update
            set sign = excluded.sign,
                home_score = excluded.home_score,
                away_score = excluded.away_score,
                is_submitted = false,
                updated_at = now();
end;
$$;

-- Delete a player and all of their bets. Cascades via the FKs on bets /
-- bonus_bets, so this wipes every trace of the player from the pool. Anyone
-- with the team password can do this — same trust model as submit_bet.
create or replace function delete_player(
    p_password      text,
    p_username      text
) returns void
language plpgsql security definer
as $$
declare
    v_username text := lower(trim(p_username));
begin
    if not verify_team_password(p_password) then
        raise exception 'invalid team password';
    end if;
    if length(v_username) = 0 then
        raise exception 'username required';
    end if;

    delete from players where username = v_username;
end;
$$;

-- Autosave tournament-wide bonus bets as a *draft* (is_submitted = false).
-- Same draft/submit model as submit_bet().
create or replace function submit_bonus_bet(
    p_password      text,
    p_username      text,
    p_champion      text,
    p_runner_up     text,
    p_top_scorer    text
) returns void
language plpgsql security definer
as $$
declare
    v_username text := lower(trim(p_username));
begin
    if not verify_team_password(p_password) then
        raise exception 'invalid team password';
    end if;
    if deadline_passed() then
        raise exception 'betting deadline has passed';
    end if;
    if length(v_username) = 0 then
        raise exception 'username required';
    end if;

    insert into players (username) values (v_username)
        on conflict (username) do nothing;

    insert into bonus_bets (username, champion, runner_up, top_scorer, is_submitted)
        values (v_username, nullif(trim(p_champion), ''), nullif(trim(p_runner_up), ''), nullif(trim(p_top_scorer), ''), false)
        on conflict (username) do update
            set champion = excluded.champion,
                runner_up = excluded.runner_up,
                top_scorer = excluded.top_scorer,
                is_submitted = false,
                updated_at = now();
end;
$$;

-- Return a player's own bets — drafts included — plus their display name.
-- This is the only way to read draft bets: the RLS read policies below hide
-- anything with is_submitted = false (and everything before the deadline), so
-- players reload their own picks through this password-checked RPC instead of
-- selecting from the tables directly.
create or replace function get_my_bets(
    p_password      text,
    p_username      text
) returns jsonb
language plpgsql stable security definer
as $$
declare
    v_username text := lower(trim(p_username));
begin
    if not verify_team_password(p_password) then
        raise exception 'invalid team password';
    end if;

    return jsonb_build_object(
        'display_name', (select display_name from players where username = v_username),
        'match_bets', coalesce(
            (select jsonb_agg(to_jsonb(b)) from bets b where b.username = v_username),
            '[]'::jsonb),
        'bonus_bet', (select to_jsonb(bb) from bonus_bets bb where bb.username = v_username)
    );
end;
$$;

-- Publish all of a player's draft bets to the public standings. Refuses if
-- the player hasn't set a display name yet — that's how we enforce the
-- "must have a real name before going public" rule. Idempotent: safe to call
-- repeatedly (the player can re-submit any time before deadline).
create or replace function submit_all_bets(
    p_password      text,
    p_username      text
) returns void
language plpgsql security definer
as $$
declare
    v_username text := lower(trim(p_username));
    v_display  text;
begin
    if not verify_team_password(p_password) then
        raise exception 'invalid team password';
    end if;
    if deadline_passed() then
        raise exception 'betting deadline has passed';
    end if;
    if length(v_username) = 0 then
        raise exception 'username required';
    end if;

    select display_name into v_display from players where username = v_username;
    if v_display is null or length(trim(v_display)) = 0 then
        raise exception 'display name required before submitting';
    end if;

    update bets
        set is_submitted = true, updated_at = now()
        where username = v_username and is_submitted = false;

    update bonus_bets
        set is_submitted = true, updated_at = now()
        where username = v_username and is_submitted = false;
end;
$$;

-- =============================================================================
-- Row-Level Security
-- =============================================================================
-- Everyone can READ matches, players, and the non-sensitive bits of settings
-- (deadline, final results) — the team_password column is NOT exposed because
-- we use a view to filter it out. Bets and bonus bets become readable only
-- once they are submitted AND the deadline has passed: before that, nobody can
-- peek at (or copy) other players' picks through the public anon key. Players
-- read their own bets back via the get_my_bets() RPC. Writes go only through
-- the SECURITY DEFINER functions above, which check the password.

alter table settings    enable row level security;
alter table matches     enable row level security;
alter table players     enable row level security;
alter table bets        enable row level security;
alter table bonus_bets  enable row level security;

-- Read policies (anon).
drop policy if exists matches_read on matches;
create policy matches_read on matches for select using (true);

drop policy if exists players_read on players;
create policy players_read on players for select using (true);

drop policy if exists bets_read on bets;
create policy bets_read on bets for select
    using (is_submitted and deadline_passed());

drop policy if exists bonus_bets_read on bonus_bets;
create policy bonus_bets_read on bonus_bets for select
    using (is_submitted and deadline_passed());

-- settings: no direct anon access. Frontend reads via the view below.
drop policy if exists settings_read on settings;
create policy settings_read on settings for select using (false);

-- Public view exposes only non-sensitive settings columns.
create or replace view public_settings as
    select deadline, top_scorer, champion, runner_up from settings where id = 1;

grant select on public_settings to anon, authenticated;

-- WHO has submitted — but not WHAT they picked. Powers the pre-deadline
-- participant list in the standings section. Like public_settings, this view
-- runs with owner privileges and so deliberately bypasses the RLS that hides
-- bets before the deadline; the only fact it leaks is that a player has
-- submitted something.
create or replace view submitted_players as
    select p.username, p.display_name
    from players p
    where exists (select 1 from bets b
                  where b.username = p.username and b.is_submitted)
       or exists (select 1 from bonus_bets bb
                  where bb.username = p.username and bb.is_submitted);

grant select on submitted_players to anon, authenticated;

-- Allow anon to call the verification + RPC functions.
grant execute on function verify_team_password(text) to anon, authenticated;
grant execute on function deadline_passed() to anon, authenticated;
grant execute on function set_display_name(text, text, text) to anon, authenticated;
grant execute on function submit_bet(text, text, bigint, text, int, int) to anon, authenticated;
grant execute on function submit_bonus_bet(text, text, text, text, text) to anon, authenticated;
grant execute on function submit_all_bets(text, text) to anon, authenticated;
grant execute on function get_my_bets(text, text) to anon, authenticated;
grant execute on function delete_player(text, text) to anon, authenticated;

-- =============================================================================
-- INITIAL SETUP — edit these two values, then run the block once.
-- =============================================================================
-- The deadline below is 1 hour before kickoff of the World Cup 2026 opening
-- match (Mexico vs South Africa, 11 June 2026, 19:00 UTC, verified from
-- football-data.org). Adjust if FIFA shifts the schedule. Change 'change-me'
-- to your real team password.

insert into settings (id, team_password, deadline) values (
    1,
    crypt('change-me', gen_salt('bf')),
    timestamptz '2026-06-11 18:00:00+00'   -- 1 h before 19:00 UTC kickoff
) on conflict (id) do nothing;

-- To CHANGE the password later, run:
--   update settings set team_password = crypt('new-password', gen_salt('bf')) where id = 1;
-- To CHANGE the deadline later, run:
--   update settings set deadline = timestamptz '2026-06-11 18:00:00+00' where id = 1;
