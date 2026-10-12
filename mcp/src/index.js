#!/usr/bin/env node
/* openGym MCP server — stdio transport. The LLM client (Claude Desktop, Cursor, …) spawns
   this process locally, talks JSON-RPC over stdin/stdout, tears it down when the session ends.
   No extra container, no new outbound network — your data stays in a folder you control. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'
import { WRITE_TOOLS } from './write-tools.js'
import { init, getUser, initApi, apiMode, refresh, stateVersion } from './state.js'
import { loadCredentials, createClient, CREDENTIALS_FILE } from './api-client.js'

const server = new McpServer({
  name: 'opengym',
  version: '0.1.0'
})

// Fail fast on bad config so a misnamed OPENGYM_DATA doesn't silently answer every call with
// the no-state sentinel. Always register every tool so the LLM sees the full list at
// handshake, even when state didn't resolve.
// Fork: with a paired token (npm run pair) the server reads and writes through the openGym API
// instead of a local ./data directory, and the write tools are offered (write-tools.js).
try {
  const creds = loadCredentials()
  if (creds) {
    await initApi(createClient(creds))
    console.error(`[opengym-mcp] paired with ${creds.url} (${CREDENTIALS_FILE})`)
  } else {
    init()
  }
  const u = getUser()
  console.error(`[opengym-mcp] serving profile ${u.name} (${u.id})`)
} catch (e) {
  console.error(`[opengym-mcp] ${e.message}`)
  // Don't exit — keep the tool listings up so the user sees a useful error after fixing their
  // env and restarting.
}

for (const t of apiMode() ? [...TOOLS, ...WRITE_TOOLS] : TOOLS) {
  server.tool(
    t.name,
    t.description,
    t.schema,
    async (params) => {
      try {
        // Paired: pick up what the phone synced since the last call (a revision check, and the
        // document only when it moved). Every answer carries the revision it was read at — the
        // `expected_version` an edit based on it must quote.
        if (apiMode()) await refresh()
        let result = await t.handler(params || {})
        if (apiMode() && result && typeof result === 'object' && !Array.isArray(result) && result.state_version === undefined) {
          result = { ...result, state_version: stateVersion() }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const code = err.code || 'ERROR'
        return {
          isError: true,
          content: [{ type: 'text', text: `${code}: ${err.message}` }]
        }
      }
    }
  )
}

const transport = new StdioServerTransport()
await server.connect(transport)
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.
