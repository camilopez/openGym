// Google Health client and tools (fork). The client runs against a fake Google (token endpoint +
// health.googleapis.com); the tools against a fake client and a seeded state. What is pinned: the
// filters the API documents, pagination, the re-auth paths, and the tools' answers when the band
// has nothing, a part of Google refuses, or nothing is connected yet.
import { describe, test, expect, beforeEach } from 'vitest'
import { _seedStateForTests } from '../src/state.js'

// No credentials file: the "not connected" answer must not depend on the developer's own setup.
// Set before google-health.js is loaded (it resolves the path at import), hence the dynamic imports.
process.env.OPENGYM_GOOGLE_HEALTH = '/nonexistent/opengym-test/google-health.json'
const { createHealthClient, exchangeCode, authUrl, SCOPES, TOKEN_URL, API } = await import('../src/google-health.js')
const { HEALTH_TOOLS, _setHealthClientForTests } = await import('../src/health-tools.js')
const byName = Object.fromEntries(HEALTH_TOOLS.map(t => [t.name, t.handler]))

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })

function fakeGoogle({ pages = 2, refresh = 'ok', rateLimitOnce = false } = {}) {
  const g = { calls: [], refreshes: 0 }
  let limited = false
  g.fetch = async (url, opts = {}) => {
    g.calls.push({ url, opts })
    if (url === TOKEN_URL) {
      g.refreshes++
      if (refresh === 'invalid_grant') return reply(400, { error: 'invalid_grant' })
      return reply(200, { access_token: 'at' + g.refreshes, expires_in: 3599 })
    }
    if (opts.headers?.Authorization !== 'Bearer at' + g.refreshes) return reply(401, { error: { message: 'bad token' } })
    if (rateLimitOnce && !limited) { limited = true; return reply(429, { error: { message: 'slow down' } }) }
    const u = new URL(url)
    const page = Number(u.searchParams.get('pageToken') || 0)
    return reply(200, {
      dataPoints: [{ n: page }],
      nextPageToken: page + 1 < pages ? String(page + 1) : ''
    })
  }
  return g
}

const creds = () => ({ client_id: 'cid', client_secret: 'sec', refresh_token: 'rt' })

describe('google-health client', () => {
  test('refreshes the access token once, follows pages, sends the filter', async () => {
    const g = fakeGoogle({ pages: 3 })
    const saved = []
    const c = createHealthClient(creds(), { fetchImpl: g.fetch, onToken: x => saved.push(x), now: () => 1e12 })
    const pts = await c.list('heart-rate', 'heart_rate.sample_time.physical_time >= "2026-10-13T04:20:00Z"', { pageSize: 10000 })
    expect(pts.map(p => p.n)).toEqual([0, 1, 2])
    expect(g.refreshes).toBe(1)
    expect(saved[0]).toMatchObject({ refresh_token: 'rt', access_token: 'at1', expires_at: 1e12 + 3599e3 })
    const first = new URL(g.calls[1].url)
    expect(first.origin + first.pathname).toBe(API + '/users/me/dataTypes/heart-rate/dataPoints')
    expect(first.searchParams.get('filter')).toBe('heart_rate.sample_time.physical_time >= "2026-10-13T04:20:00Z"')
    expect(first.searchParams.get('pageSize')).toBe('10000')
    expect(new URL(g.calls[2].url).searchParams.get('pageToken')).toBe('1')
  })

  test('a 429 is waited out once', async () => {
    const g = fakeGoogle({ pages: 1, rateLimitOnce: true })
    let waited = 0
    const c = createHealthClient(creds(), { fetchImpl: g.fetch, onToken: () => {}, wait: async ms => { waited += ms } })
    expect(await c.list('sleep', '')).toHaveLength(1)
    expect(waited).toBeGreaterThan(0)
  })

  test('a 401 with a cached token refreshes and retries', async () => {
    const g = fakeGoogle({ pages: 1 })
    const c = createHealthClient({ ...creds(), access_token: 'stale', expires_at: Date.now() + 3600e3 }, { fetchImpl: g.fetch, onToken: () => {} })
    expect(await c.list('sleep', '')).toHaveLength(1)
    expect(g.refreshes).toBe(1)
  })

  test('an expired refresh token says how to re-authorize', async () => {
    const g = fakeGoogle({ refresh: 'invalid_grant' })
    const c = createHealthClient(creds(), { fetchImpl: g.fetch, onToken: () => {} })
    await expect(c.list('sleep', '')).rejects.toMatchObject({ code: 'EHEALTHAUTH', message: expect.stringContaining('npm run health-auth') })
  })

  test('consent URL asks for offline, read-only access with PKCE', () => {
    const u = new URL(authUrl({ clientId: 'cid', redirectUri: 'http://localhost:8765/oauth2callback', state: 's', codeChallenge: 'ch' }))
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('scope').split(' ')).toEqual(SCOPES)
    expect(SCOPES.every(s => s.endsWith('.readonly'))).toBe(true)
  })

  test('code exchange keeps what refreshing needs', async () => {
    const fetchImpl = async (url, opts) => {
      const body = new URLSearchParams(opts.body)
      expect(body.get('code_verifier')).toBe('v')
      return reply(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: SCOPES.join(' ') })
    }
    const c = await exchangeCode({ clientId: 'cid', clientSecret: 'sec', code: 'c', redirectUri: 'x', codeVerifier: 'v' }, { fetchImpl, now: () => 0 })
    expect(c).toMatchObject({ client_id: 'cid', client_secret: 'sec', refresh_token: 'r', expires_at: 3600e3 })
  })
})

/* ---------- tools ---------- */

const T0 = Date.parse('2026-10-13T04:30:00Z')
const hr = (t, bpm) => ({ heartRate: { sampleTime: { physicalTime: new Date(t).toISOString(), utcOffset: '7200s' }, beatsPerMinute: String(bpm) } })

function seed() {
  _seedStateForTests({
    unit: 'kg',
    customEx: [],
    workouts: [
      { id: 'w1', d: '2026-10-13', name: 'Legs A', start: T0, end: T0 + 45 * 60e3, entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: true, at: T0 + 5 * 60e3 }] }] },
      { id: 'w2', d: '2026-10-12', name: 'Strong import' },
      { id: 'w3', d: '2026-10-11', start: T0 - 2 * 864e5, end: T0 - 2 * 864e5 + 30 * 60e3, entries: [] },
      { id: 'w4', d: '2026-10-11', start: T0 - 2 * 864e5 + 10 * 3600e3, end: T0 - 2 * 864e5 + 11 * 3600e3, entries: [] }
    ]
  })
}

function fakeClient(answers) {
  const c = { calls: [] }
  c.list = async (type, filter, opts) => {
    c.calls.push({ type, filter, opts })
    const a = answers[type]
    if (a instanceof Error) throw a
    return a || []
  }
  return c
}

describe('health tools', () => {
  beforeEach(() => { seed(); _setHealthClientForTests(null) })

  test('not connected: the answer is the setup steps', async () => {
    await expect(byName.get_recovery({})).rejects.toMatchObject({ code: 'ENOHEALTH', message: expect.stringContaining('health-auth') })
  })

  test('get_workout_heart_rate asks for the session ±window in physical time and reads it', async () => {
    const pts = []
    for (let t = T0 - 10 * 60e3; t < T0 + 60 * 60e3; t += 5000) pts.push(hr(t, t < T0 ? 68 : 110))
    const c = fakeClient({ 'heart-rate': pts })
    _setHealthClientForTests(c)
    const r = await byName.get_workout_heart_rate({ workout_id: 'w1', max_hr: 177 })
    expect(c.calls[0].filter).toBe('heart_rate.sample_time.physical_time >= "2026-10-13T04:20:00Z" AND heart_rate.sample_time.physical_time < "2026-10-13T05:30:00Z"')
    expect(r.workout).toEqual({ id: 'w1', date: '2026-10-13', routine_name: 'Legs A' })
    expect(r.session).toMatchObject({ minutes: 45, avg_bpm: 110 })
    expect(r.before_session_avg_bpm).toBe(68)
    expect(r.sets[0]).toMatchObject({ exercise: expect.any(String), set: 1, peak_bpm: 110 })
    expect(r.max_hr_used).toBe(177)
  })

  test('no samples: says why instead of zeros', async () => {
    _setHealthClientForTests(fakeClient({}))
    const r = await byName.get_workout_heart_rate({ date: '2026-10-13' })
    expect(r.heart_rate).toBeNull()
    expect(r.note).toMatch(/synced/)
  })

  test('imported session without times, and a day with two sessions', async () => {
    _setHealthClientForTests(fakeClient({}))
    await expect(byName.get_workout_heart_rate({ workout_id: 'w2' })).rejects.toMatchObject({ code: 'ENOTIME' })
    const r = await byName.get_workout_heart_rate({ date: '2026-10-11' })
    expect(r.ambiguous).toBe(true)
    expect(r.workouts.map(w => w.id)).toEqual(['w3', 'w4'])
  })

  test('get_recovery: daily filters by date, sleep by wake time; a refused part is reported, not fatal', async () => {
    const c = fakeClient({
      'daily-resting-heart-rate': [{ dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 13 }, beatsPerMinute: '61' } }],
      'daily-heart-rate-variability': Object.assign(new Error('Google Health API 403: denied'), { code: 'EHEALTH' }),
      sleep: []
    })
    _setHealthClientForTests(c)
    const r = await byName.get_recovery({ from: '2026-10-01', to: '2026-10-13' })
    expect(c.calls.map(x => x.filter)).toEqual([
      'daily_resting_heart_rate.date >= "2026-10-01" AND daily_resting_heart_rate.date < "2026-10-14"',
      'daily_heart_rate_variability.date >= "2026-10-01" AND daily_heart_rate_variability.date < "2026-10-14"',
      'sleep.interval.civil_end_time >= "2026-10-01" AND sleep.interval.civil_end_time < "2026-10-14"'
    ])
    expect(c.calls[2].opts).toEqual({ pageSize: 25 })
    expect(r.days).toEqual([{ date: '2026-10-13', resting_hr: 61 }])
    expect(r.unavailable).toEqual({ hrv: 'Google Health API 403: denied' })
  })

  test('ranges are checked', async () => {
    _setHealthClientForTests(fakeClient({}))
    await expect(byName.get_recovery({ from: '2026-10-13', to: '2026-10-01' })).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(byName.list_tracked_activities({ from: '2026-01-01', to: '2026-10-13' })).rejects.toMatchObject({ code: 'EINVAL' })
  })

  test('list_tracked_activities matches overlaps with logged workouts', async () => {
    const ex = (start, end, name) => ({ exercise: { interval: { startTime: start, startUtcOffset: '7200s', endTime: end, endUtcOffset: '7200s' }, exerciseType: 'OTHER', displayName: name, metricsSummary: {} } })
    const c = fakeClient({ exercise: [ex('2026-10-13T18:30:00Z', '2026-10-13T20:00:00Z', 'BJJ'), ex('2026-10-13T04:35:00Z', '2026-10-13T05:10:00Z', 'Weights')] })
    _setHealthClientForTests(c)
    const r = await byName.list_tracked_activities({ from: '2026-10-13', to: '2026-10-13' })
    expect(c.calls[0].filter).toBe('exercise.interval.civil_start_time >= "2026-10-13" AND exercise.interval.civil_start_time < "2026-10-14"')
    expect(r.activities.map(a => [a.name, a.opengym_workout_id])).toEqual([['Weights', 'w1'], ['BJJ', null]])
  })
})
