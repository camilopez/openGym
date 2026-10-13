# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Cursor, Cline, Continue, etc.) read your openGym profile —
routines, workouts, body-weight log, estimated 1RMs, and muscle balance — directly from your
self-hosted `./data` directory.

It is read-only, runs locally as a stdio process spawned by the LLM client, adds no new
container, and requires no extra authentication. The LLM never sees passkeys, VAPID keys, or
session secrets — it can only read the same `state-<uid>.json` files the openGym api already
writes.

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Phase 1 of a multi-phase plan. Read-only today; long-lived token auth + write tools are
> planned but not shipped yet. See **Roadmap** below.

## Fork: paired API mode with write tools

> This fork (camilopez/openGym) adds a bridge until upstream ships its own write tools (#116,
> v1.4.3): the MCP pairs with the server like the phone app and reads **and writes** through the
> API, so it runs on any machine that reaches the server — no access to `./data` needed, no
> server change, official images unchanged.

```bash
cd mcp && npm ci
# In openGym (signed in): Settings → Account → "Pair the mobile app" → code
npm run pair -- https://gym.example.com CODE     # token → ~/.config/opengym-mcp/credentials.json (0600)
claude mcp add opengym --scope user -- node /absolute/path/to/openGym/mcp/src/index.js
```

With credentials present the server starts in paired mode (no credentials: the original
`./data` mode below). Every tool answer then carries `state_version`, and six tools are added:

| Tool | What it does |
|---|---|
| `search_exercises` | Find exercise ids in the library and the user's own exercises |
| `create_routine` | Add a routine (sets, reps or rep range, weight, rest, supersets, progression) |
| `edit_routine` | Replace a routine's exercise list, keeping its id; retained slots keep settings the tool cannot express |
| `delete_routine` | Remove a routine (needs `confirm: true`); history stays |
| `set_week_plan` | Assign routines to weekdays |
| `set_next_weight` | Pin the weight one exercise opens at in its next session, over history and progression |

How a write is made (`src/write-tools.js`): routines go through the app's plan-file import
(`parsePlan`/`mergePlan`), the change is stamped with `stampChange` like `store.update` does, and
`PUT /api/data` is conditional on the revision just read. Edits, deletions and schedule changes
also require the `expected_version` of the read they are based on. A 409 (a device saved in
between) writes nothing and is never retried blind, and a document that would differ in
workouts, weigh-ins, measurements, lift weights or unit is refused before it is sent.

The weight on a routine normally only seeds an exercise with no history: once it has been
logged, history and the progression policy pick the next weight. A weight the coach sets on
purpose is stamped on the slot (`weightAt`) and wins for the next session only — the session it
opens is logged after the stamp, so from then on progression carries on from what was lifted
(`nextPrescription` in `frontend/src/lib/progression.js`). `set_next_weight` stamps one slot;
`create_routine` and `edit_routine` stamp a weight that changes, never one resent unchanged.
"Sign out everywhere" in Settings revokes the token.

## Fork: heart rate from Google Health

Three read-only tools lay a Fitbit's data (Google Health API, `health.googleapis.com/v4`, the
successor of the Fitbit Web API) next to the training log. They are offered in both modes and
answer with these setup steps until Google is connected.

| Tool | What it does |
|---|---|
| `get_workout_heart_rate` | One workout against the band's HR: avg/max, zones, 10 min before and 15 after, per set the peak, the drop a minute later and the lowest HR before the next set |
| `get_recovery` | Per day: resting HR, overnight HRV, sleeping HR and the night's sleep (stages, efficiency, naps), with the range's mean/SD as baseline |
| `list_tracked_activities` | Exercise the band recorded (BJJ, runs…), matched to openGym workouts when they overlap |

Sets are placed by the moment they were ticked in the app (`at`), so a session logged live reads
set by set; ticks seconds apart were logged afterwards and are flagged `ticked_in_batch`.
Imported sessions (Strong) carry no start/end and cannot be lined up. Time in zones needs a max
HR: pass `max_hr`, or set `OPENGYM_MAX_HR` in the MCP's environment.

One-time setup:

1. Sign in to the **Google Health** app on the phone with the Google account the Fitbit uses
   (Google only answers for an account linked there).
2. In [Google Cloud](https://console.cloud.google.com/): create a project and enable the
   **Google Health API**.
3. **Google Auth Platform → Branding/Audience:** user type *External*; add your Google account
   under *Test users*. **Data Access:** add the three read-only scopes
   `googlehealth.health_metrics_and_measurements.readonly`, `googlehealth.sleep.readonly`,
   `googlehealth.activity_and_fitness.readonly`.
4. **Clients → Create client → Web application**, authorized redirect URI
   `http://localhost:8765/oauth2callback`. Download the client JSON.
5. Authorize:

   ```bash
   cd mcp && npm run health-auth -- ~/Downloads/client_secret_XXXX.json
   ```

   It opens the consent page and saves the tokens owner-only to
   `~/.config/opengym-mcp/google-health.json` (`OPENGYM_GOOGLE_HEALTH` overrides;
   `OPENGYM_HEALTH_PORT` changes the 8765). No restart needed afterwards.

**Token expiry.** All Google Health scopes are *restricted*. While the app's publishing status is
*Testing*, Google expires the refresh token after 7 days, and the tools then say so: run
`npm run health-auth` again (the saved client is reused). Publishing the app (Audience → *Publish
app*) stops the weekly expiry; unverified, it stays capped at 100 users and shows an "unverified
app" warning on consent, which for a personal project is just you.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js
```

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected if you have one profile
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

## Tools

Nine read-only tools in v1:

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none. No database driver, no HTTP framework.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **No new auth.** The filesystem is the boundary — same as `docker compose` running on the
  user's box. No passkey material, VAPID keys, or session secrets ever cross it.
- **No telemetry, no network.** Reads `./data/*.json` and exits when the LLM client
  disconnects.

## Tests

```bash
cd mcp && npm test
```

58 cases seeding state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on). Pins JSON shape and the user-facing edge cases: rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own 92 tests in `frontend/src/lib/*.test.js`.

## Roadmap

- **Done (Phase 1):** read-only stdio, 8 tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Phase 2:** read+write over stdio. Requires a long-lived token auth path minted from the
  admin dashboard (new `./data/tokens.json`) and a write-lock against the web UI's read-modify-
  write of `state-<uid>.json`. Tools: `log_workout`, `add_bodyweight`, `edit_routine`,
  `assign_weekday`, `override_day`.
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.
