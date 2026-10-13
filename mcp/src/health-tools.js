/* Health tools (fork): the Fitbit's heart rate, recovery and tracked activities from the Google
   Health API, read next to the openGym log so coaching can weigh how a session went and how
   recovered the athlete was going in. Read-only on both sides. Offered in either data mode;
   until `npm run health-auth` has run, each call answers with the setup steps. */
import { z } from 'zod'
import { getState } from './state.js'
import { loadHealthCredentials, createHealthClient } from './google-health.js'
import { hrSamples, analyzeWorkoutHr, recoveryDays, activityView, PRE_MS, POST_MS } from './heart-rate.js'
import { exOr } from '../../frontend/src/lib/exercises.js'

const fail = (code, message) => Object.assign(new Error(message), { code })
const DAY = 24 * 60 * 60 * 1000
const MAX_RANGE_DAYS = 90

const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine(
  v => { const d = new Date(v + 'T12:00:00'); return !Number.isNaN(d.getTime()) && localIso(d) === v },
  { message: 'not a date the calendar has (YYYY-MM-DD)' }
)
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localIso(d) }
const rfc3339 = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/* ---------- the Google Health client, loaded on first use ---------- */

let _client = null
export function _setHealthClientForTests(c) { _client = c }

async function health(run) {
  if (!_client) {
    const creds = loadHealthCredentials()
    if (!creds) {
      throw fail('ENOHEALTH', 'Google Health is not connected yet — follow mcp/README.md "Heart rate from Google Health": create the OAuth client in Google Cloud, then run `npm run health-auth -- <client_secret.json>` in mcp/')
    }
    _client = createHealthClient(creds)
  }
  try {
    return await run(_client)
  } catch (e) {
    // Re-read the credentials on the next call, so a fresh `npm run health-auth` needs no restart.
    if (e.code === 'EHEALTHAUTH') _client = null
    throw e
  }
}

function range(from, to) {
  const end = to || localIso(new Date())
  const start = from || addDays(end, -13)
  if (start > end) throw fail('EINVAL', `from (${start}) is after to (${end})`)
  if ((Date.parse(end) - Date.parse(start)) / DAY + 1 > MAX_RANGE_DAYS) throw fail('EINVAL', `at most ${MAX_RANGE_DAYS} days per call`)
  return { start, end, endExcl: addDays(end, 1) }
}

function nameOf(S) {
  return id => (S.customEx || []).find(x => x.id === id)?.n || exOr(id).n || id
}

function findWorkout(S, { workout_id, date }) {
  const workouts = S.workouts || []
  if (workout_id) {
    const w = workouts.find(x => x.id === workout_id)
    if (!w) throw fail('ENOENT', `no workout with id ${workout_id}`)
    return { w }
  }
  if (!date) throw fail('EINVAL', 'needs either workout_id or date')
  const sameDay = workouts.filter(x => x.d === date)
  if (!sameDay.length) throw fail('ENOENT', `no workout on ${date}`)
  if (sameDay.length > 1) {
    return {
      ambiguous: {
        ambiguous: true,
        date,
        message: `${sameDay.length} workouts were logged on ${date} — call again with one of these workout_id values.`,
        workouts: sameDay.map(x => ({ id: x.id || null, routine_name: x.name || null }))
      }
    }
  }
  return { w: sameDay[0] }
}

const maxHrSchema = z.number().int().min(120).max(230).optional()
  .describe('The athlete\'s max heart rate, for time in zones (50/60/70/80/90 % of it). Defaults to OPENGYM_MAX_HR if set; without either, zones are left out. With no measured max, 208 − 0.7 × age is a fair estimate.')
const envMaxHr = () => { const n = Number(process.env.OPENGYM_MAX_HR); return n >= 120 && n <= 230 ? n : null }

/* ---------- tools ---------- */

/** get_workout_heart_rate — one logged session against the band's heart rate, set by set. */
export const getWorkoutHeartRate = {
  name: 'get_workout_heart_rate',
  description: 'Lay the Fitbit heart rate (Google Health) over one openGym workout: session avg/max, time in zones, the 10 minutes before and 15 after, and per completed set its peak, the drop one minute later (hrr60) and the lowest HR in the rest before the next set. Sets are placed by the moment they were ticked; ticks seconds apart (logged after the fact) are flagged ticked_in_batch and left out of the summary. Wrist HR lags and under-reads during heavy grips, so read peaks as approximate. Identify the session by workout_id (list_workouts) or date.',
  schema: {
    workout_id: z.string().min(1).optional().describe('The id from list_workouts. Preferred: it names one session even on a day with two.'),
    date: isoDate().optional().describe('The workout date as YYYY-MM-DD.'),
    max_hr: maxHrSchema
  },
  handler: async ({ workout_id, date, max_hr }) => {
    const S = getState()
    if (!S) throw fail('ENOSTATE', 'this profile has no synced state yet')
    const found = findWorkout(S, { workout_id, date })
    if (found.ambiguous) return found.ambiguous
    const w = found.w
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) {
      throw fail('ENOTIME', `workout ${w.id || w.d} has no start/end time (imported sessions don't), so there is nothing to line the heart rate up with`)
    }
    const from = w.start - PRE_MS
    const to = w.end + POST_MS
    const points = await health(c => c.list('heart-rate',
      `heart_rate.sample_time.physical_time >= "${rfc3339(from)}" AND heart_rate.sample_time.physical_time < "${rfc3339(to)}"`,
      { pageSize: 10000 }))
    const samples = hrSamples(points)
    const head = { id: w.id || null, date: w.d, routine_name: w.name || null }
    if (!samples.length) {
      return {
        workout: head,
        heart_rate: null,
        note: 'no heart-rate samples in Google Health for this session — the band may not have synced yet (open the Google Health app on the phone), or it was not worn'
      }
    }
    return { workout: head, ...analyzeWorkoutHr(w, samples, { maxHr: max_hr || envMaxHr(), nameOf: nameOf(S) }) }
  }
}

/** get_recovery — resting HR, HRV and sleep per day, with the range's own baseline. */
export const getRecovery = {
  name: 'get_recovery',
  description: 'Daily recovery markers from the Fitbit (Google Health) for a date range: resting heart rate, overnight HRV (avg RMSSD and deep-sleep RMSSD, ms), sleeping HR, and the night that ended that morning (bed/wake time, minutes asleep, efficiency, deep/REM/light/awake minutes, naps). Includes the range\'s mean and SD as a baseline: resting HR well above it or HRV well below it means under-recovered. Defaults to the last 14 days; at most 90.',
  schema: {
    from: isoDate().optional().describe('First day, YYYY-MM-DD. Default: 13 days before `to`.'),
    to: isoDate().optional().describe('Last day, YYYY-MM-DD. Default: today.')
  },
  handler: async ({ from, to }) => {
    const { start, end, endExcl } = range(from, to)
    const daily = t => `${t}.date >= "${start}" AND ${t}.date < "${endExcl}"`
    const parts = await health(c => Promise.allSettled([
      c.list('daily-resting-heart-rate', daily('daily_resting_heart_rate')),
      c.list('daily-heart-rate-variability', daily('daily_heart_rate_variability')),
      c.list('sleep', `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${endExcl}"`, { pageSize: 25 })
    ]))
    const names = ['resting_hr', 'hrv', 'sleep']
    const failed = parts.map((p, i) => p.status === 'rejected' ? [names[i], p.reason] : null).filter(Boolean)
    if (failed.length === parts.length) throw failed[0][1]
    if (failed.some(([, e]) => e.code === 'EHEALTHAUTH')) _client = null
    const got = parts.map(p => (p.status === 'fulfilled' ? p.value : []))
    return {
      from: start,
      to: end,
      ...recoveryDays({ rhr: got[0], hrv: got[1], sleep: got[2] }),
      ...(failed.length ? { unavailable: Object.fromEntries(failed.map(([k, e]) => [k, e.message])) } : {})
    }
  }
}

/** list_tracked_activities — what the band recorded as exercise, matched to openGym sessions. */
export const listTrackedActivities = {
  name: 'list_tracked_activities',
  description: 'Exercise sessions the Fitbit recorded (Google Health) in a date range — e.g. BJJ, runs, walks, and lifting it auto-detected — with duration, average HR, calories, active zone minutes and minutes per HR zone. opengym_workout_id is set when the activity overlaps a logged openGym workout; the rest is training load openGym does not see (BJJ above all). Defaults to the last 14 days; at most 90.',
  schema: {
    from: isoDate().optional().describe('First day, YYYY-MM-DD. Default: 13 days before `to`.'),
    to: isoDate().optional().describe('Last day, YYYY-MM-DD. Default: today.')
  },
  handler: async ({ from, to }) => {
    const { start, end, endExcl } = range(from, to)
    const points = await health(c => c.list('exercise',
      `exercise.interval.civil_start_time >= "${start}" AND exercise.interval.civil_start_time < "${endExcl}"`,
      { pageSize: 25 }))
    const workouts = getState()?.workouts || []
    const activities = points.map(p => activityView(p, workouts)).filter(Boolean)
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
    return { from: start, to: end, count: activities.length, activities }
  }
}

export const HEALTH_TOOLS = [getWorkoutHeartRate, getRecovery, listTrackedActivities]
