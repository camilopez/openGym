#!/usr/bin/env node
/* Authorize this MCP to read your Google Health data (fork). One time, then again only if Google
   drops the authorization (README → "Heart rate from Google Health"):
     npm run health-auth -- ~/Downloads/client_secret_XXXX.json   first time: the OAuth client
     npm run health-auth                                           later: reuses the saved client
   Opens the consent page, catches the redirect on http://localhost:8765/oauth2callback (the
   redirect URI the OAuth client must list), and saves the tokens owner-only to
   ~/.config/opengym-mcp/google-health.json (OPENGYM_GOOGLE_HEALTH overrides). */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import {
  HEALTH_FILE, SCOPES, authUrl, exchangeCode, createHealthClient, saveHealthCredentials
} from './google-health.js'

const PORT = Number(process.env.OPENGYM_HEALTH_PORT) || 8765
const REDIRECT = `http://localhost:${PORT}/oauth2callback`
const TIMEOUT_MS = 5 * 60 * 1000

function clientFromArgs() {
  const file = process.argv[2]
  if (file) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const c = j.web || j.installed || j
    if (!c.client_id || !c.client_secret) throw new Error(`${file} has no client_id/client_secret`)
    return { clientId: c.client_id, clientSecret: c.client_secret }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'))
    if (saved.client_id && saved.client_secret) return { clientId: saved.client_id, clientSecret: saved.client_secret }
  } catch { /* first run */ }
  throw new Error('usage: npm run health-auth -- <client_secret_….json downloaded from Google Cloud>')
}

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function waitForCode(state) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT)
      if (u.pathname !== '/oauth2callback') { res.writeHead(404).end(); return }
      const done = (status, text, outcome) => {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text)
        server.close()
        clearTimeout(timer)
        outcome()
      }
      if (u.searchParams.get('state') !== state) return done(400, 'State mismatch — run health-auth again.', () => reject(new Error('state mismatch')))
      if (u.searchParams.get('error')) return done(400, `Google said: ${u.searchParams.get('error')}`, () => reject(new Error(u.searchParams.get('error'))))
      done(200, 'openGym MCP authorized. You can close this tab.', () => resolve(u.searchParams.get('code')))
    })
    const timer = setTimeout(() => { server.close(); reject(new Error('no answer from the consent page within 5 minutes')) }, TIMEOUT_MS)
    server.on('error', reject)
    server.listen(PORT, '127.0.0.1')
  })
}

try {
  const { clientId, clientSecret } = clientFromArgs()
  const state = b64url(crypto.randomBytes(16))
  const codeVerifier = b64url(crypto.randomBytes(48))
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest())
  const url = authUrl({ clientId, redirectUri: REDIRECT, state, codeChallenge })
  const pending = waitForCode(state)
  console.log(`Opening the Google consent page. If no browser opens, visit:\n\n${url}\n`)
  if (process.platform === 'darwin') execFile('open', [url], () => {})
  const code = await pending
  const creds = await exchangeCode({ clientId, clientSecret, code, redirectUri: REDIRECT, codeVerifier })
  saveHealthCredentials(creds)
  const missing = SCOPES.filter(s => !creds.scope.split(' ').includes(s))
  if (missing.length) console.warn(`Warning: not granted, the matching tools will fail: ${missing.map(s => s.split('.').slice(-2).join('.')).join(', ')}`)
  // Google only answers for an account linked in the Google Health app; check now, not mid-coaching.
  const id = await createHealthClient(creds).identity()
  console.log(`Authorized (Google Health user ${id.healthUserId || '?'}). Credentials: ${HEALTH_FILE}`)
} catch (e) {
  console.error(`Authorization failed: ${e.message}`)
  process.exit(1)
}
