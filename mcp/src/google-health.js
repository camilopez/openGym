/* Google Health API client (fork): the heart rate, resting heart rate, HRV, sleep and tracked
   activities a Fitbit records, read-only, so the coach can lay them next to the logged sessions.
   The Google Health API (health.googleapis.com/v4) replaced the Fitbit Web API, which Google
   turned off on 2026-10-30. Auth is Google OAuth 2.0: `npm run health-auth` (health-auth.js)
   stores a refresh token owner-only beside the openGym pairing, and this client trades it for
   short-lived access tokens as calls need them. Nothing is written to Google. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HEALTH_FILE = process.env.OPENGYM_GOOGLE_HEALTH ||
  path.join(os.homedir(), '.config', 'opengym-mcp', 'google-health.json')

export const API = 'https://health.googleapis.com/v4'
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'

// Read-only, and only what the tools use: heart rate, resting HR and HRV live under health
// metrics, sleep has its own scope, tracked activities (a BJJ class, a run) are fitness.
const SCOPE = 'https://www.googleapis.com/auth/googlehealth.'
export const SCOPES = [
  SCOPE + 'health_metrics_and_measurements.readonly',
  SCOPE + 'sleep.readonly',
  SCOPE + 'activity_and_fitness.readonly'
]

const TIMEOUT_MS = 20000
const fail = (code, message) => Object.assign(new Error(message), { code })

export const REAUTH_HINT = 'run `npm run health-auth` in mcp/ again. While the OAuth app is in "Testing", Google expires the authorization after 7 days; publishing it (Google Auth Platform → Audience → Publish app) stops that'

export function loadHealthCredentials(file = HEALTH_FILE) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  const c = JSON.parse(raw)
  if (!c || typeof c.client_id !== 'string' || typeof c.client_secret !== 'string' || typeof c.refresh_token !== 'string') {
    throw fail('EHEALTHAUTH', `${path.basename(file)} has no client_id/client_secret/refresh_token — ${REAUTH_HINT}`)
  }
  return c
}

// A refresh token reads the user's health data: owner-only, written whole or not at all.
export function saveHealthCredentials(c, file = HEALTH_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** The consent URL. `prompt=consent` + `access_type=offline` so Google hands out a refresh token every time. */
export function authUrl({ clientId, redirectUri, state, codeChallenge }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  })
  return AUTH_URL + '?' + q
}

async function tokenCall(params, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const d = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, d }
}

/** Trade the code from the consent redirect for tokens. */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }, { fetchImpl = fetch, now = Date.now } = {}) {
  const { ok, status, d } = await tokenCall({
    client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri,
    code_verifier: codeVerifier, grant_type: 'authorization_code'
  }, fetchImpl)
  if (!ok) throw fail('EHEALTHAUTH', `token exchange failed: ${d.error_description || d.error || 'HTTP ' + status}`)
  if (!d.refresh_token) throw fail('EHEALTHAUTH', 'Google returned no refresh token — remove the app at myaccount.google.com/permissions and authorize again')
  return {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: d.refresh_token,
    access_token: d.access_token,
    expires_at: now() + (Number(d.expires_in) || 3600) * 1000,
    scope: d.scope || '',
    authorized_at: new Date(now()).toISOString()
  }
}

export function createHealthClient(creds, {
  fetchImpl = fetch, onToken = saveHealthCredentials, now = Date.now,
  wait = ms => new Promise(r => setTimeout(r, ms))
} = {}) {
  let access = creds.access_token || null
  let expiresAt = Number(creds.expires_at) || 0

  async function token() {
    if (access && now() < expiresAt - 60000) return access
    const { ok, status, d } = await tokenCall({
      client_id: creds.client_id, client_secret: creds.client_secret,
      refresh_token: creds.refresh_token, grant_type: 'refresh_token'
    }, fetchImpl)
    if (!ok) {
      if (d.error === 'invalid_grant') throw fail('EHEALTHAUTH', `Google no longer accepts the saved authorization — ${REAUTH_HINT}`)
      throw fail('EHEALTH', `token refresh failed: ${d.error_description || d.error || 'HTTP ' + status}`)
    }
    access = d.access_token
    expiresAt = now() + (Number(d.expires_in) || 3600) * 1000
    Object.assign(creds, { access_token: access, expires_at: expiresAt }, d.refresh_token ? { refresh_token: d.refresh_token } : {})
    try { onToken({ ...creds }) } catch { /* a cache write failing costs one extra refresh, nothing more */ }
    return access
  }

  async function get(route, retried = false) {
    const res = await fetchImpl(API + route, {
      headers: { Authorization: 'Bearer ' + await token(), Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    // One retry each: a revoked access token is refreshed, a rate limit (300/min per user) waited out.
    if (res.status === 401 && !retried) { access = null; return get(route, true) }
    if (res.status === 429 && !retried) { await wait(2000); return get(route, true) }
    const d = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = d.error?.message || d.error?.status || 'HTTP ' + res.status
      if (res.status === 401 || res.status === 403) throw fail('EHEALTHAUTH', `Google Health API ${res.status}: ${msg} — ${REAUTH_HINT}`)
      throw fail('EHEALTH', `Google Health API ${res.status}: ${msg}`)
    }
    return d
  }

  return {
    identity: () => get('/users/me/identity'),
    pairedDevices: () => get('/users/me/pairedDevices'),
    /** Every data point of a type matching `filter` (AIP-160), following nextPageToken. */
    async list(dataType, filter, { pageSize, maxPages = 20 } = {}) {
      const points = []
      let pageToken = ''
      for (let page = 0; page < maxPages; page++) {
        const q = new URLSearchParams()
        if (filter) q.set('filter', filter)
        if (pageSize) q.set('pageSize', String(pageSize))
        if (pageToken) q.set('pageToken', pageToken)
        const d = await get(`/users/me/dataTypes/${dataType}/dataPoints?${q}`)
        points.push(...(d.dataPoints || []))
        pageToken = d.nextPageToken || ''
        if (!pageToken) return points
      }
      throw fail('EHEALTH', `${dataType}: more than ${maxPages} pages — ask for a shorter range`)
    }
  }
}
