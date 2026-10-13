/* Heart rate and recovery read against the training log (fork). Pure: Google Health data points
   and openGym workouts in, plain numbers out — google-health.js fetches, health-tools.js wires.

   How a session is read: every set the app ticks is stamped with `at` (Workout.jsx), so the gap
   between two ticks is the set plus the rest before it. A wrist sensor lags the effort and peaks
   just after the last rep, so a set's peak is looked for from a minute before its tick to a few
   seconds after. The set itself has no recorded start: the last SET_MS of a gap are taken as the
   next set's work, and what comes before is rest. Ticks seconds apart were logged after the
   fact, not lifted, and are flagged rather than read. */
import { isWarmupRow } from '../../frontend/src/lib/workout-model.js'

const SEC = 1000
const MIN = 60 * SEC
export const PRE_MS = 10 * MIN        // looked at before the session starts
export const POST_MS = 15 * MIN       // and after it ends
const PEAK_BEFORE = 60 * SEC
const PEAK_AFTER = 20 * SEC
const SET_MS = 45 * SEC               // assumed length of the set that ends at a tick
const HRR_AT = 60 * SEC               // heart-rate recovery: the drop one minute after the peak
const BATCH_GAP = 20 * SEC            // ticks closer than this were logged, not lifted
const MAX_REST = 15 * MIN             // a longer gap is a break, not a rest
const SAMPLE_CAP = 30 * SEC           // one sample stands for at most this long in zone time
const ZONES = [0.5, 0.6, 0.7, 0.8, 0.9]   // % of max HR where zones 1–5 start

const round = v => (v == null || !Number.isFinite(v) ? null : Math.round(v))
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = xs => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sd = xs => {
  const m = mean(xs)
  return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : null
}
const pad = n => String(n).padStart(2, '0')
const inWin = (samples, from, to) => samples.filter(s => s.t >= from && s.t < to)

/** Local wall-clock HH:MM:SS of an epoch ms, in this machine's zone (the athlete's). */
export const clock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }

/** A protobuf Duration ("3600s", "-7200s", "12.5s") in seconds. */
export const durationS = v => { const n = parseFloat(String(v ?? '').replace(/s$/, '')); return Number.isFinite(n) ? n : null }

/** google.type.Date ({year, month, day}) or an ISO string → 'YYYY-MM-DD'. */
export function dateIso(d) {
  if (!d) return null
  if (typeof d === 'string') return d.slice(0, 10)
  return d.year ? `${d.year}-${pad(d.month || 1)}-${pad(d.day || 1)}` : null
}

// The wall-clock date and time a session timestamp had where it happened. The API's civil
// fields are output-only and proto JSON drops zero fields (midnight has no `hours`), so the
// physical time plus its UTC offset is the fallback.
function civil(cdt, ts, offset) {
  if (cdt?.date) {
    const t = cdt.time || {}
    return { date: dateIso(cdt.date), time: `${pad(t.hours || 0)}:${pad(t.minutes || 0)}` }
  }
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return { date: null, time: null }
  const iso = new Date(ms + (durationS(offset) || 0) * SEC).toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
}

/* ---------- heart-rate samples ---------- */

/** heart-rate data points → [{t, bpm}] by time, one per instant (two sources can report the same one). */
export function hrSamples(points) {
  const byT = new Map()
  for (const p of points || []) {
    const h = p?.heartRate
    if (!h) continue
    const t = Date.parse(h.sampleTime?.physicalTime)
    const bpm = Number(h.beatsPerMinute)
    if (!Number.isFinite(t) || !(bpm >= 25 && bpm <= 250) || byT.has(t)) continue
    byT.set(t, bpm)
  }
  return [...byT].map(([t, bpm]) => ({ t, bpm })).sort((a, b) => a.t - b.t)
}

function stats(samples) {
  if (!samples.length) return null
  const bpm = samples.map(s => s.bpm)
  return { avg: round(mean(bpm)), min: Math.min(...bpm), max: Math.max(...bpm) }
}

/** How densely the window is sampled — a long gap means the band was off or lost contact. */
export function coverage(samples, from, to) {
  const s = inWin(samples, from, to)
  if (!s.length) return { samples: 0, median_interval_s: null, longest_gap_s: round((to - from) / SEC) }
  const gaps = [s[0].t - from, ...s.slice(1).map((x, i) => x.t - s[i].t), to - s[s.length - 1].t]
  const between = gaps.slice(1, -1)
  return {
    samples: s.length,
    median_interval_s: between.length ? round(median(between) / SEC) : null,
    longest_gap_s: round(Math.max(...gaps) / SEC)
  }
}

/** Minutes per zone (% of max HR). Each sample counts until the next one, at most SAMPLE_CAP. */
export function zoneMinutes(samples, from, to, maxHr) {
  const out = { below_z1: 0, z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 }
  const s = inWin(samples, from, to)
  s.forEach((x, i) => {
    const until = i + 1 < s.length ? s[i + 1].t : to
    const ms = Math.min(until - x.t, SAMPLE_CAP)
    const z = ZONES.filter(f => x.bpm >= f * maxHr).length
    out[z ? 'z' + z : 'below_z1'] += ms
  })
  for (const k in out) out[k] = Math.round(out[k] / MIN * 10) / 10
  return out
}

/* ---------- one session ---------- */

/** Completed sets that carry a tick time, in the order they were done. */
export function setTicks(workout) {
  const ticks = []
  for (const e of workout?.entries || []) {
    (e.sets || []).forEach((s, i) => {
      const done = s?.done || s?.sides?.L?.done || s?.sides?.R?.done
      if (!done || !Number.isFinite(s.at)) return
      ticks.push({ exId: e.id, set: i + 1, at: s.at, warmup: isWarmupRow(s) })
    })
  }
  return ticks.sort((a, b) => a.at - b.at)
}

export function analyzeWorkoutHr(workout, samples, { maxHr = null, nameOf = id => id } = {}) {
  const { start, end } = workout
  const ticks = setTicks(workout)
  const sets = ticks.map((k, i) => {
    const prev = ticks[i - 1]
    const next = ticks[i + 1]
    const gap = next ? next.at - k.at : null
    const rest = gap != null && gap <= MAX_REST ? gap : null
    const batch = (gap != null && gap < BATCH_GAP) || (prev && k.at - prev.at < BATCH_GAP)
    const peak = stats(inWin(samples, k.at - PEAK_BEFORE, k.at + PEAK_AFTER))?.max ?? null
    let hrr60 = null
    if (peak != null && !batch && (gap == null || gap >= HRR_AT + 5 * SEC + SET_MS)) {
      const near = inWin(samples, k.at + HRR_AT - 5 * SEC, k.at + HRR_AT + 5 * SEC)
      if (near.length) hrr60 = peak - round(mean(near.map(s => s.bpm)))
    }
    let low = null
    if (rest != null && !batch && rest - SET_MS > PEAK_AFTER) {
      low = stats(inWin(samples, k.at + PEAK_AFTER, next.at - SET_MS))?.min ?? null
    }
    return {
      exercise: nameOf(k.exId),
      set: k.set,
      ...(k.warmup ? { warmup: true } : {}),
      at: clock(k.at),
      peak_bpm: peak,
      hrr60_bpm: hrr60,
      rest_s: rest == null ? null : round(rest / SEC),
      low_bpm_before_next: low,
      ...(batch ? { ticked_in_batch: true } : {})
    }
  })

  const work = sets.filter(s => !s.warmup && !s.ticked_in_batch)
  const med = key => round(median(work.map(s => s[key]).filter(v => v != null)))
  const session = stats(inWin(samples, start, end))
  const at = (t, half) => round(mean(inWin(samples, t - half, t + half).map(s => s.bpm)))

  return {
    window: { from: clock(start - PRE_MS), start: clock(start), end: clock(end), to: clock(end + POST_MS) },
    coverage: coverage(samples, start, end),
    session: session ? { minutes: round((end - start) / MIN), avg_bpm: session.avg, max_bpm: session.max, min_bpm: session.min } : null,
    before_session_avg_bpm: stats(inWin(samples, start - PRE_MS, start))?.avg ?? null,
    after_session: {
      bpm_at_end: at(end, 30 * SEC),
      bpm_5min_after: at(end + 5 * MIN, 30 * SEC),
      bpm_15min_after: at(end + POST_MS - 30 * SEC, 30 * SEC)
    },
    ...(maxHr ? { max_hr_used: maxHr, zone_minutes: zoneMinutes(samples, start, end, maxHr) } : {}),
    rest_summary: {
      work_sets_read: work.length,
      median_rest_s: med('rest_s'),
      median_peak_bpm: med('peak_bpm'),
      median_hrr60_bpm: med('hrr60_bpm'),
      median_low_bpm_before_next: med('low_bpm_before_next')
    },
    sets
  }
}

/* ---------- recovery: resting HR, HRV, sleep ---------- */

export function sleepView(p) {
  const s = p?.sleep
  if (!s?.interval) return null
  const i = s.interval
  const bed = civil(i.civilStartTime, i.startTime, i.startUtcOffset)
  const wake = civil(i.civilEndTime, i.endTime, i.endUtcOffset)
  const sum = s.summary || {}
  const num = v => (v == null ? null : Number(v))
  const stages = {}
  for (const st of sum.stagesSummary || []) stages[String(st.type || '').toLowerCase()] = Number(st.minutes) || 0
  const inBed = num(sum.minutesInSleepPeriod) ?? round((Date.parse(i.endTime) - Date.parse(i.startTime)) / MIN)
  const asleep = num(sum.minutesAsleep)
  return {
    wake_date: wake.date,
    bed: bed.time,
    wake: wake.time,
    nap: !!s.metadata?.nap,
    main: s.metadata?.mainSleep ?? null,
    asleep_min: asleep,
    in_bed_min: inBed,
    efficiency_pct: asleep != null && inBed ? round(asleep / inBed * 100) : null,
    awake_min: num(sum.minutesAwake) ?? stages.awake ?? null,
    to_fall_asleep_min: num(sum.minutesToFallAsleep),
    deep_min: stages.deep ?? null,
    rem_min: stages.rem ?? null,
    light_min: stages.light ?? null
  }
}

/** One row per date: the night that ended that morning, resting HR and HRV, plus the range's baseline. */
export function recoveryDays({ rhr = [], hrv = [], sleep = [] }) {
  const days = new Map()
  const day = d => { if (!days.has(d)) days.set(d, { date: d }); return days.get(d) }

  for (const p of rhr) {
    const r = p?.dailyRestingHeartRate
    const d = dateIso(r?.date)
    if (d && r.beatsPerMinute != null) day(d).resting_hr = Number(r.beatsPerMinute)
  }
  for (const p of hrv) {
    const h = p?.dailyHeartRateVariability
    const d = dateIso(h?.date)
    if (!d) continue
    const x = day(d)
    // RMSSD is 1–200 ms by the API's own range; a night without enough deep sleep comes back as 0.
    const ms = v => (Number(v) > 0 ? round(Number(v) * 10) / 10 : null)
    if (ms(h.averageHeartRateVariabilityMilliseconds) != null) x.hrv_ms = ms(h.averageHeartRateVariabilityMilliseconds)
    if (ms(h.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds) != null) x.deep_sleep_rmssd_ms = ms(h.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds)
    if (h.nonRemHeartRateBeatsPerMinute != null) x.sleeping_hr = Number(h.nonRemHeartRateBeatsPerMinute)
  }
  const byWake = new Map()
  for (const p of sleep) {
    const v = sleepView(p)
    if (!v?.wake_date) continue
    if (!byWake.has(v.wake_date)) byWake.set(v.wake_date, [])
    byWake.get(v.wake_date).push(v)
  }
  for (const [d, list] of byWake) {
    const naps = list.filter(v => v.nap)
    const nights = list.filter(v => !v.nap)
    const main = nights.find(v => v.main) || nights.sort((a, b) => (b.asleep_min || 0) - (a.asleep_min || 0))[0]
    const x = day(d)
    if (main) { const { wake_date, nap, main: _, ...night } = main; x.sleep = night }
    if (naps.length) x.nap_min = naps.reduce((a, v) => a + (v.asleep_min || 0), 0)
  }

  const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  const base = pick => {
    const xs = rows.map(pick).filter(v => v != null)
    return xs.length ? { mean: round(mean(xs) * 10) / 10, sd: xs.length > 1 ? round(sd(xs) * 10) / 10 : null, days: xs.length } : null
  }
  return {
    baseline: {
      resting_hr: base(r => r.resting_hr),
      hrv_ms: base(r => r.hrv_ms),
      asleep_min: base(r => r.sleep?.asleep_min)
    },
    days: rows
  }
}

/* ---------- tracked activities (a BJJ class, a run) ---------- */

export function activityView(p, workouts = []) {
  const x = p?.exercise
  if (!x?.interval) return null
  const i = x.interval
  const startMs = Date.parse(i.startTime)
  const endMs = Date.parse(i.endTime)
  const st = civil(i.civilStartTime, i.startTime, i.startUtcOffset)
  const m = x.metricsSummary || {}
  const z = m.heartRateZoneDurations
  const zm = v => { const s = durationS(v); return s == null ? null : round(s / 60) }
  const same = workouts.find(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.start < endMs && w.end > startMs)
  return {
    date: st.date,
    start: st.time,
    minutes: round((endMs - startMs) / MIN),
    active_minutes: zm(x.activeDuration),
    type: x.exerciseType || null,
    name: x.displayName || null,
    avg_bpm: m.averageHeartRateBeatsPerMinute != null ? Number(m.averageHeartRateBeatsPerMinute) : null,
    kcal: m.caloriesKcal != null ? round(m.caloriesKcal) : null,
    active_zone_minutes: m.activeZoneMinutes != null ? Number(m.activeZoneMinutes) : null,
    ...(z ? { zone_minutes: { light: zm(z.lightTime), moderate: zm(z.moderateTime), vigorous: zm(z.vigorousTime), peak: zm(z.peakTime) } } : {}),
    opengym_workout_id: same ? same.id || null : null
  }
}
