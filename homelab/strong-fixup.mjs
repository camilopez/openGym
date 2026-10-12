#!/usr/bin/env node
// Rewrites a Strong export into a file the openGym importer reads correctly, without touching
// the original:
//
//   node homelab/strong-fixup.mjs strong.csv strong-fixed.csv [homelab/strong-exercise-map.json]
//
// Strong encodes the set's kind in "Set Order" — W (warm-up), F (to failure), D (drop set) —
// and writes the rest timer as rows of its own ("Rest Timer", Seconds = the rest). openGym
// v1.4.1 reads none of that: warm-ups land as work sets and every rest timer as a timed set
// of the exercise. Here the timer rows are dropped and the kind goes into a "Set Type" column,
// which the importer does read. The optional map renames Strong exercise names to the
// openGym library name they should resolve to.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseCSV } from '../frontend/src/lib/import-csv.js'

const [src, dst, mapFile] = process.argv.slice(2)
if (!src || !dst) {
  console.error('usage: node homelab/strong-fixup.mjs <strong.csv> <out.csv> [map.json]')
  process.exit(2)
}

const rows = parseCSV(readFileSync(src, 'utf8'))
const head = rows[0]
const col = name => head.findIndex(h => h.trim().toLowerCase() === name)
const iOrder = col('set order'), iName = col('exercise name')
if (iOrder < 0 || iName < 0) {
  console.error('Not a Strong export: no "Set Order" / "Exercise Name" columns')
  process.exit(1)
}
const rename = mapFile ? JSON.parse(readFileSync(mapFile, 'utf8')) : {}

const KIND = { W: 'warmup', F: 'failure', D: 'dropset' }
const out = [[...head, 'Set Type']]
const n = { rest: 0, warmup: 0, failure: 0, dropset: 0, renamed: 0 }
for (const r of rows.slice(1)) {
  const order = (r[iOrder] || '').trim()
  if (/^rest timer$/i.test(order)) { n.rest++; continue }
  const kind = KIND[order.toUpperCase()] || ''
  if (kind) n[kind]++
  const name = (r[iName] || '').trim()
  if (rename[name]) { r[iName] = rename[name]; n.renamed++ }
  out.push([...r, kind])
}

const quote = v => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
writeFileSync(dst, out.map(r => r.map(v => quote(String(v ?? ''))).join(',')).join('\n') + '\n')
console.log(`Wrote ${dst}: ${out.length - 1} sets. Dropped ${n.rest} rest-timer rows; ` +
  `marked ${n.warmup} warm-up, ${n.failure} to-failure, ${n.dropset} drop sets; renamed ${n.renamed}.`)
