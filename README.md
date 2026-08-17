# Ryder Cup

A lightweight web app for running a workplace Ryder Cup: three rounds of match play
(scramble, alternate shot, singles) between two teams, with per-hole net scoring driven
by each player's handicap.

- **Front end:** React + Vite, hosted free on GitHub Pages
- **Back end:** Supabase (Postgres + Auth + row-level security)
- **Scoring:** a dependency-free engine in `src/lib/` (allocates handicap strokes by
  stroke index, computes each hole's net winner, tracks the match, and closes it out
  at e.g. `3&2`)

## The flow

1. **Organizer** starts an event (from the Setup tab), sets the join code, the course
   card (par + stroke index), team names/colours, captains, and creates the three rounds.
2. **Players** join with the code, their name, and handicap, and set a password.
3. **Captains** draft teams from the signup pool (alternating snake order) and set the
   matchups for each round.
4. On the day, players open their match, enter **gross strokes per hole**; the board
   shows the live match status and updates the leaderboard. Hitting **Submit** locks the
   result.

## Handicap allowances (configurable in Setup)

| Format          | Default allowance                          |
|-----------------|--------------------------------------------|
| Singles         | 100% of each player's handicap             |
| Alternate shot  | 50% of the pair's combined handicap        |
| Scramble        | 35% of the low handicap + 15% of the high  |

The higher-handicap side receives the difference in strokes, allocated to the
lowest stroke-index holes. Change any percentage in the Setup tab — no code edits.

## Setup

### 1. Supabase
1. Create a free project at supabase.com.
2. Open the SQL editor and run `supabase/schema.sql`.
3. In **Authentication → Providers**, keep Email enabled. For a fast event, turn
   **Confirm email** off (Authentication → Settings) so players can sign in immediately.
4. Copy your project URL and publishable key (sb_publishable_...) from **Settings → API**.

### 2. Run locally
```bash
cp .env.example .env.local     # paste your Supabase URL + publishable key
npm install
npm run dev
```
Open the app, click **Start an event** to become the organizer.

### 3. Deploy to GitHub Pages
1. Push this repo to GitHub (`main` branch).
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. Repo **Settings → Secrets and variables → Actions** — add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
   - `VITE_BASE` — only if your repo isn't named `ryder-cup` (use `"/your-repo-name/"`)
4. Push. The workflow in `.github/workflows/deploy.yml` builds and publishes.

The publishable key is meant to ship in the browser; your data is protected by the
row-level-security policies in the schema, not by hiding the key.

## Project layout

```
src/
  lib/scoring.js        match-play engine (stroke allocation, hole winners, closeout)
  lib/handicap.js       format allowances -> side handicaps
  lib/matchcompute.js   glue: DB rows -> engine -> team points
  pages/                Login, Signup, Lobby (leaderboard), ScoreEntry,
                        Draft, Matchups, AdminSetup (+ Start event)
  components/TugBar.jsx  the cup / tug-of-war leaderboard bar
supabase/schema.sql     tables, join-code + create-event RPCs, RLS baseline
```

## Notes / things you may want to adjust

- **RLS is a sensible baseline, not hardened.** Review the policies in `schema.sql`
  before a wider rollout — e.g. locking score edits once `submitted` is true, or
  restricting team assignment to each team's own captain.
- **Handicaps** are treated as the playing handicap you enter at signup (whole-course).
  If you want full WHS course/slope conversion, that's an extension point in `handicap.js`.
- **Live updates** currently refresh on page load / navigation. If you want the
  leaderboard to tick without refreshing, wire in Supabase Realtime subscriptions on the
  `hole_scores` and `matches` tables.
- Works the same on a self-hosted GitLab repo — only the Pages deploy step is GitHub-specific.
