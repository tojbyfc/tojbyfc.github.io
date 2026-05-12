# World Cup 2026 Betting

An internal team betting pool for the FIFA World Cup 2026. Players pick a 1X2
sign and exact score for every match, plus champion / runner-up / top scorer.
Bets stay editable until 1 hour before the opening game, then lock; live match
data is pulled from [football-data.org](https://www.football-data.org/) every
hour and standings update automatically.

**Scoring** (same as the original spreadsheet):

| Outcome | Points |
| --- | ---: |
| Correct 1X2 sign | 1 |
| Correct exact score | 3 (replaces the 1) |
| Correct champion | 5 |
| Correct runner-up | 5 |
| Correct top scorer | 5 |

## Architecture

- **Frontend** — static HTML/CSS/JS in this repo, deployable to GitHub Pages.
- **Database + auth** — Supabase (Postgres). The team password is bcrypt-hashed
  in the `settings` table; writes go through `SECURITY DEFINER` Postgres
  functions that verify the password server-side, so the public anon key is
  safe to ship to browsers.
- **Live scores** — a GitHub Action runs `scripts/update-results.mjs` hourly,
  pulling from football-data.org with a private API key (stored as a GitHub
  secret) and upserting into Supabase.

## One-time setup

You'll need three accounts (all free):
1. **Supabase** — for the database.
2. **football-data.org** — for live match data.
3. **GitHub** — to host the page and run the hourly cron.

### 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a new project.
   Pick any region near you; the free tier is plenty.
2. Once it's ready, open **SQL Editor → New query**, paste the contents of
   `supabase/schema.sql`, and run it.
3. The script seeds a `settings` row with the placeholder password
   `change-me`. Change it now:

   ```sql
   update settings
   set team_password = crypt('your-real-team-password', gen_salt('bf'))
   where id = 1;
   ```

   Share that password with your teammates only.
4. The schema sets the betting deadline to `2026-06-11 18:00 UTC` (1 hour
   before the 19:00 UTC opening kickoff Mexico vs South Africa, verified from
   football-data.org). Adjust if FIFA shifts the schedule:

   ```sql
   update settings set deadline = timestamptz '2026-06-11 18:00:00+00' where id = 1;
   ```

5. Open **Project settings → API** and copy:
   - The **Project URL** (looks like `https://xxxxx.supabase.co`)
   - The **anon public** key
   - The **service_role** key (treat this like a password)

### 2. Get a football-data.org API key

1. Register at [football-data.org/client/register](https://www.football-data.org/client/register).
2. You get a free token by email. The World Cup competition (code `WC`) is on
   the free plan.

### 3. Configure the frontend

Edit `js/config.js` and paste in the **anon** key + URL:

```js
export const SUPABASE_URL = 'https://xxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';   // anon key, NOT service_role
```

These are public — they ship to the browser, but the team password gate
prevents unauthorized writes.

### 4. Seed the fixture list

Copy `.env.example` to `.env` and fill in the three values
(`FOOTBALL_DATA_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`). The scripts
auto-load `.env` so you don't need to export them. Then:

```bash
npm install
npm run seed
```

You should see `Upserted N matches.` (104 for World Cup 2026) along with a
rate-limit summary like `9 requests left this minute`.

### 5. Set up the hourly cron

In the GitHub repo for this project, go to **Settings → Secrets and variables →
Actions** and add three repository secrets:

- `FOOTBALL_DATA_TOKEN` — your football-data.org token
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_SERVICE_KEY` — your Supabase service_role key

The workflow in `.github/workflows/update-results.yml` then runs every hour
during the tournament. You can also trigger it manually from the **Actions**
tab via "Run workflow".

### 6. Deploy to GitHub Pages

Push this folder as the root of a GitHub repo (e.g. `world-cup-betting`), then:

- **Settings → Pages → Source: Deploy from a branch → main / root**
- Wait a minute, then visit `https://<username>.github.io/<repo>/`.

That's it. Share the URL and the team password with your players.

## Running locally

```bash
# any tiny static server works
python3 -m http.server 8000
# then open http://localhost:8000
```

## How players use it

1. Open the URL.
2. Type their name + team password → "Sign in".
3. Fill in score predictions for every match (the 1X2 sign auto-fills from the
   score, but is editable). Each row autosaves as you type — but as a *draft*
   that only you can see.
4. Fill in champion / runner-up / top scorer. These autosave the same way.
5. When you're ready, click **"Skicka in mina tips"** — a dialog confirms that
   you agree to add 10 € to the pot, and your tips become visible to everyone
   in the standings.
6. Come back any time before the deadline to tweak picks and resubmit. Edits
   flip the affected bet back to draft until you submit again.
7. Watch the standings during the tournament.

## After the tournament

To award the bonus points, log into Supabase SQL Editor and set the final
results:

```sql
update settings set
    champion   = 'Brazil',
    runner_up  = 'France',
    top_scorer = 'Kylian Mbappé'
where id = 1;
```

The standings recompute automatically on the next page load.

> Player bonus picks are stored as free-text. Make sure the strings match
> exactly — e.g. if a player typed "Brasil" instead of "Brazil" they won't
> score. You can audit and normalize via:
> `select player_name, champion, runner_up, top_scorer from bonus_bets;`

## Layout of this repo

```
.
├── index.html                       # Single-page UI
├── js/
│   ├── config.js                    # ← fill in Supabase URL + anon key
│   ├── supabase-client.js           # DB wrapper
│   ├── app.js                       # UI logic
│   └── scoring.js                   # Standings calculation
├── supabase/
│   └── schema.sql                   # Run once in Supabase SQL editor
├── scripts/
│   ├── seed-fixtures.mjs            # Initial fixture load
│   └── update-results.mjs           # Hourly score sync
├── .github/workflows/
│   └── update-results.yml           # Cron job
├── package.json
└── README.md
```
