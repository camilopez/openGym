#!/usr/bin/env node
// Dry run of "Import from another app" for a Strong export: runs the app's own importer over
// the file and prints what would land and how every exercise name resolves. Touches no server
// and no state.
//
//   node homelab/check-strong-csv.mjs ~/Downloads/strong.csv [kg|lb]
//
// The unit is the PROFILE's: Strong's Weight column carries none, so the importer takes it to
// be in the profile's unit already.
import { readFileSync } from 'node:fs'
import { parseCSV, parseWorkoutCSV, matchExercise } from '../frontend/src/lib/import-csv.js'
import { EXIDX, canonicalExId } from '../frontend/src/lib/exercises.js'

const [file, unit = 'kg'] = process.argv.slice(2)
if (!file || !['kg', 'lb'].includes(unit)) {
  console.error('usage: node homelab/check-strong-csv.mjs <export.csv> [kg|lb]')
  process.exit(2)
}

const text = readFileSync(file, 'utf8')
const p = parseWorkoutCSV(text, { unit })
if (p.error) {
  console.error(`Not importable: ${p.error}`)
  process.exit(1)
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`Source detected:   ${p.source}`)
console.log(`Range:             ${p.from} → ${p.to}`)
console.log(`Workouts:          ${p.workouts.length}`)
console.log(`Sets:              ${p.sets} (warm-ups ${p.warmups}, skipped as implausible ${p.skipped})`)
console.log(`Sets with RPE:     ${p.rpeSets}`)
console.log(`Unit:              file says ${p.fileUnit || 'nothing'}, profile ${unit}${p.converted ? ' → CONVERTED' : ''}${p.mixedUnits ? ' (mixed kg/lb!)' : ''}`)
console.log(`Exercises:         ${p.matched} matched to the library, ${p.created} new custom`)

// Sets per name in the file, and what each name resolves to — the same call the importer makes.
const rows = parseCSV(text)
const col = rows[0].findIndex(h => h.toLowerCase().replace(/[^a-z]+/g, ' ').trim() === 'exercise name')
const counts = new Map()
for (const r of rows.slice(1)) {
  const n = (r[col] || '').trim()
  if (n) counts.set(n, (counts.get(n) || 0) + 1)
}
const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1])

console.log('\nMatched to the library (check the fuzzy ones):')
for (const [name, n] of byCount) {
  const id = canonicalExId(matchExercise(name))
  if (id) console.log(`  ${pad(n, 5)} ${pad(name, 40)} → ${EXIDX[id]?.n ?? id}`)
}
console.log('\nBecome custom exercises:')
for (const [name, n] of byCount) {
  if (!canonicalExId(matchExercise(name))) console.log(`  ${pad(n, 5)} ${name}`)
}
