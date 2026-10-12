/* The paired-API data source (fork: homelab bridge until upstream's write tools land, #116).
   Instead of reading ./data off the server's disk, the MCP talks to the openGym API with the same
   bearer token the phone app pairs for (POST /api/pair/redeem), so it can run on any machine that
   reaches the server and write through the same revision-checked PUT /api/data the apps use. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CREDENTIALS_FILE = process.env.OPENGYM_CREDENTIALS ||
  path.join(os.homedir(), '.config', 'opengym-mcp', 'credentials.json')

const TIMEOUT_MS = 15000

export function loadCredentials(file = CREDENTIALS_FILE) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  const c = JSON.parse(raw)
  if (!c || typeof c.url !== 'string' || typeof c.token !== 'string') throw new Error(`${path.basename(file)} has no url/token — pair again`)
  return c
}

// The token signs the profile in: owner-only, written whole or not at all.
export function saveCredentials(c, file = CREDENTIALS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export const normalizeUrl = u => String(u || '').trim().replace(/\/+$/, '')

export class ApiError extends Error {
  constructor(status, data, message) {
    super(message || data?.error || `HTTP ${status}`)
    this.status = status
    this.data = data
    this.code = status === 401 ? 'EAUTH' : status === 409 ? 'ECONFLICT' : 'EAPI'
  }
}

/** Redeem a pairing code (Settings → Account → "Pair the mobile app") for a bearer token. */
export async function redeemPairCode(url, code, { fetchImpl = fetch } = {}) {
  const base = normalizeUrl(url)
  const res = await fetchImpl(base + '/api/pair/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: String(code).trim() }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.token) throw new ApiError(res.status, data, data.error || 'pairing failed')
  return { url: base, token: data.token, user: data.user }
}

export function createClient(creds, { fetchImpl = fetch, onToken = saveCredentials } = {}) {
  const base = normalizeUrl(creds.url)
  let token = creds.token

  async function call(method, route, body) {
    const res = await fetchImpl(base + route, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (res.status === 401) throw new ApiError(401, data, 'the server no longer accepts this MCP\'s token — pair it again (Settings → Account → Pair the mobile app, then `npm run pair`)')
      throw new ApiError(res.status, data)
    }
    return data
  }

  return {
    url: base,
    // GET /api/me hands a token past half its life a fresh one, as it does for the phone app.
    async me() {
      const d = await call('GET', '/api/me')
      if (d.token && d.token !== token) { token = d.token; onToken({ ...creds, url: base, token }) }
      return d.user
    },
    rev: () => call('GET', '/api/data/rev'),
    data: () => call('GET', '/api/data'),
    // The app's own push: stamped, and conditional on the revision (and write id) it read.
    put: (state, baseRev, baseWid) => call('PUT', '/api/data', {
      state, stamped: true, baseRev, ...(baseWid ? { baseWid } : {})
    })
  }
}
