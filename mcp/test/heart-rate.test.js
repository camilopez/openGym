// heart-rate.js (fork): Google Health data points read against a logged session. A synthetic
// band is driven from the set ticks — each set climbs to 140 bpm just after its tick and falls
// back to 95 within a minute — so the per-set numbers have known answers.
import { describe, test, expect } from 'vitest'
import {
  hrSamples, coverage, zoneMinutes, setTicks, analyzeWorkoutHr, recoveryDays, sleepView,
  activityView, durationS, dateIso, PRE_MS, POST_MS
} from '../src/heart-rate.js'

const S = 1000
const M = 60 * S
const T0 = Date.parse('2026-10-13T04:30:00Z')
const TICKS = [5 * M, 8 * M, 11 * M].map(o => T0 + o)

function bpmAt(t) {
  if (t < T0) return 70
  for (const k of TICKS) {
    if (t >= k - 45 * S && t <= k + 10 * S) return Math.round(95 + (t - (k - 45 * S)) / (55 * S) * 45)
    if (t > k + 10 * S && t <= k + 70 * S) return Math.round(140 - (t - (k + 10 * S)) / (60 * S) * 45)
  }
  return 95
}
const point = (t, bpm) => ({ heartRate: { sampleTime: { physicalTime: new Date(t).toISOString(), utcOffset: '7200s' }, beatsPerMinute: String(bpm) } })
function band(from, to, step = 5 * S) {
  const out = []
  for (let t = from; t < to; t += step) out.push(point(t, bpmAt(t)))
  return out
}

const workout = {
  id: 'w1', d: '2026-10-13', start: T0, end: T0 + 20 * M,
  entries: [
    { id: '0025', sets: TICKS.map(at => ({ w: 60, r: 8, done: true, at })) },
    // Two rows ticked five seconds apart at the end: logged after the fact, not lifted.
    { id: '0027', sets: [{ w: 40, r: 10, done: true, at: T0 + 15 * M }, { w: 40, r: 10, done: true, at: T0 + 15 * M + 5 * S }, { w: 40, r: 10, done: false }] }
  ]
}

describe('hrSamples', () => {
  test('parses int64-as-string bpm, sorts, drops duplicates and impossible values', () => {
    const t = Date.parse('2026-10-13T05:00:00Z')
    const s = hrSamples([point(t + 5 * S, 90), point(t, 80), point(t, 81), point(t + 10 * S, 400), { steps: {} }])
    expect(s).toEqual([{ t, bpm: 80 }, { t: t + 5 * S, bpm: 90 }])
  })
})

describe('coverage and zones', () => {
  test('a gap in the band shows as the longest gap', () => {
    const pts = [...band(T0, T0 + 5 * M), ...band(T0 + 9 * M, T0 + 10 * M)]
    const c = coverage(hrSamples(pts), T0, T0 + 10 * M)
    expect(c.median_interval_s).toBe(5)
    expect(c.longest_gap_s).toBe(245)
  })
  test('zone minutes add up to the sampled time', () => {
    const samples = hrSamples(band(T0, T0 + 20 * M))
    const z = zoneMinutes(samples, T0, T0 + 20 * M, 180)
    const total = Object.values(z).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(20, 0)
    // The peaks reach 140 = 78 % of 180: zone 3, never zone 4 (144+).
    expect(z.z3).toBeGreaterThan(0)
    expect(z.z4).toBe(0)
  })
})

describe('analyzeWorkoutHr', () => {
  const samples = hrSamples(band(T0 - PRE_MS, T0 + 20 * M + POST_MS))
  const r = analyzeWorkoutHr(workout, samples, { maxHr: 180, nameOf: id => ({ '0025': 'Bench', '0027': 'Row' })[id] })

  test('only completed, ticked sets, in the order they were done', () => {
    expect(setTicks(workout).map(t => [t.exId, t.set])).toEqual([['0025', 1], ['0025', 2], ['0025', 3], ['0027', 1], ['0027', 2]])
  })

  test('per set: peak at the tick, drop a minute later, lowest HR before the next set', () => {
    const [s1, s2] = r.sets
    expect(s1).toMatchObject({ exercise: 'Bench', set: 1, peak_bpm: 140, rest_s: 180, low_bpm_before_next: 95 })
    expect(s1.hrr60_bpm).toBeGreaterThanOrEqual(25)
    expect(s1.hrr60_bpm).toBeLessThanOrEqual(40)
    expect(s2.peak_bpm).toBe(140)
  })

  test('ticks seconds apart are flagged and kept out of the summary', () => {
    const rows = r.sets.filter(s => s.exercise === 'Row')
    expect(rows.every(s => s.ticked_in_batch)).toBe(true)
    expect(rows.every(s => s.hrr60_bpm === null && s.low_bpm_before_next === null)).toBe(true)
    expect(r.rest_summary.work_sets_read).toBe(3)
    expect(r.rest_summary.median_rest_s).toBe(180)
  })

  test('session, before and after', () => {
    expect(r.session).toMatchObject({ minutes: 20, max_bpm: 140, min_bpm: 95 })
    expect(r.before_session_avg_bpm).toBe(70)
    expect(r.after_session.bpm_5min_after).toBe(95)
    expect(r.max_hr_used).toBe(180)
    expect(r.zone_minutes).toBeDefined()
  })

  test('no max HR, no zones', () => {
    const r2 = analyzeWorkoutHr(workout, samples)
    expect(r2.zone_minutes).toBeUndefined()
    expect(r2.sets[0].exercise).toBe('0025')
  })

  test('a gap over 15 minutes is a break, not a rest', () => {
    const w = { ...workout, entries: [{ id: '0025', sets: [{ done: true, at: T0 + M }, { done: true, at: T0 + 20 * M }] }] }
    expect(analyzeWorkoutHr(w, samples).sets[0].rest_s).toBeNull()
  })
})

describe('recovery', () => {
  const sleep = (start, end, startOff, endOff, extra = {}) => ({
    sleep: {
      interval: { startTime: start, startUtcOffset: startOff, endTime: end, endUtcOffset: endOff, ...(extra.interval || {}) },
      metadata: extra.metadata || { mainSleep: true },
      summary: extra.summary || {
        minutesAsleep: '400', minutesInSleepPeriod: '440', minutesAwake: '40', minutesToFallAsleep: '8',
        stagesSummary: [{ type: 'DEEP', minutes: '70', count: '4' }, { type: 'REM', minutes: '90' }, { type: 'LIGHT', minutes: '240' }, { type: 'AWAKE', minutes: '40' }]
      }
    }
  })

  test('helpers', () => {
    expect(durationS('7200s')).toBe(7200)
    expect(durationS('-3.5s')).toBe(-3.5)
    expect(dateIso({ year: 2026, month: 10, day: 3 })).toBe('2026-10-03')
    expect(dateIso('2026-10-03')).toBe('2026-10-03')
  })

  test('a night is dated by the morning it ended, in local time from the offset', () => {
    const v = sleepView(sleep('2026-10-12T20:50:00Z', '2026-10-13T04:10:00Z', '7200s', '7200s'))
    expect(v).toMatchObject({ wake_date: '2026-10-13', bed: '22:50', wake: '06:10', asleep_min: 400, in_bed_min: 440, efficiency_pct: 91, deep_min: 70, rem_min: 90 })
  })

  test('civil times win over the offset fallback when the API sends them (midnight has no hours)', () => {
    const v = sleepView(sleep('2026-10-12T22:00:00Z', '2026-10-13T05:00:00Z', '0s', '0s', {
      interval: { civilStartTime: { date: { year: 2026, month: 10, day: 13 }, time: { minutes: 0 } }, civilEndTime: { date: { year: 2026, month: 10, day: 13 }, time: { hours: 7 } } }
    }))
    expect(v).toMatchObject({ wake_date: '2026-10-13', bed: '00:00', wake: '07:00' })
  })

  test('days merge resting HR, HRV and sleep; naps apart; baseline over the range', () => {
    const r = recoveryDays({
      rhr: [
        { dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 12 }, beatsPerMinute: '58' } },
        { dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 13 }, beatsPerMinute: '64' } }
      ],
      // A night without enough deep sleep reports its deep-sleep RMSSD as 0: missing, not a reading.
      hrv: [{ dailyHeartRateVariability: { date: { year: 2026, month: 10, day: 13 }, averageHeartRateVariabilityMilliseconds: 31.27, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 0, nonRemHeartRateBeatsPerMinute: '60' } }],
      sleep: [
        sleep('2026-10-12T20:50:00Z', '2026-10-13T04:10:00Z', '7200s', '7200s'),
        sleep('2026-10-13T13:00:00Z', '2026-10-13T13:30:00Z', '7200s', '7200s', { metadata: { nap: true }, summary: { minutesAsleep: '25' } })
      ]
    })
    expect(r.days.map(d => d.date)).toEqual(['2026-10-12', '2026-10-13'])
    expect(r.days[1]).toMatchObject({ resting_hr: 64, hrv_ms: 31.3, sleeping_hr: 60, nap_min: 25 })
    expect(r.days[1]).not.toHaveProperty('deep_sleep_rmssd_ms')
    expect(r.days[1].sleep).toMatchObject({ asleep_min: 400, bed: '22:50' })
    expect(r.baseline.resting_hr).toEqual({ mean: 61, sd: 4.2, days: 2 })
    expect(r.baseline.hrv_ms.sd).toBeNull()
  })
})

describe('activityView', () => {
  test('summarises the band\'s exercise and matches it to an overlapping openGym workout', () => {
    const p = {
      exercise: {
        interval: { startTime: '2026-10-13T04:32:00Z', startUtcOffset: '7200s', endTime: '2026-10-13T05:15:00Z', endUtcOffset: '7200s' },
        exerciseType: 'WEIGHTLIFTING', displayName: 'Weights', activeDuration: '2400s',
        metricsSummary: { averageHeartRateBeatsPerMinute: '112', caloriesKcal: 310.4, activeZoneMinutes: '18', heartRateZoneDurations: { lightTime: '1200s', moderateTime: '900s', vigorousTime: '300s' } }
      }
    }
    expect(activityView(p, [workout])).toEqual({
      date: '2026-10-13', start: '06:32', minutes: 43, active_minutes: 40, type: 'WEIGHTLIFTING', name: 'Weights',
      avg_bpm: 112, kcal: 310, active_zone_minutes: 18,
      zone_minutes: { light: 20, moderate: 15, vigorous: 5, peak: null },
      opengym_workout_id: 'w1'
    })
    const bjj = { exercise: { ...p.exercise, interval: { ...p.exercise.interval, startTime: '2026-10-13T18:30:00Z', endTime: '2026-10-13T20:00:00Z' } } }
    expect(activityView(bjj, [workout]).opengym_workout_id).toBeNull()
  })
})
