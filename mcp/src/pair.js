#!/usr/bin/env node
/* Pair this MCP with an openGym server, the way the phone app pairs (fork):
     1. In openGym (signed in): Settings → Account → "Pair the mobile app" shows a code.
     2. npm run pair -- https://gym.example.com CODE
   The token is saved owner-only to ~/.config/opengym-mcp/credentials.json (OPENGYM_CREDENTIALS
   overrides). It renews itself while the MCP is used; "Sign out everywhere" revokes it. */
import { redeemPairCode, saveCredentials, CREDENTIALS_FILE } from './api-client.js'

const [url, code] = process.argv.slice(2)
if (!url || !code) {
  console.error('usage: npm run pair -- <server url> <pairing code>')
  process.exit(2)
}
try {
  const { url: base, token, user } = await redeemPairCode(url, code)
  saveCredentials({ url: base, token })
  console.log(`Paired with ${base} as ${user?.name || 'your profile'}. Credentials: ${CREDENTIALS_FILE}`)
} catch (e) {
  console.error(`Pairing failed: ${e.message}`)
  process.exit(1)
}
