// Write tools over the paired API (fork). The API is an in-memory stand-in with the server's
// revision rules (PUT /api/data refuses a baseRev that is not current, answers 409 with the
// document), seeded from the demo profile. What is pinned: a write changes only the plan,
// goes out stamped and conditional, refuses stale versions, and never retries over a device
// that saved in between.
import { describe, beforeEach, test, expect } from 'vitest'
import { z } from 'zod'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { createClient } from '../src/api-client.js'
import { initApi, refresh, getState, stateVersion } from '../src/state.js'
import { WRITE_TOOLS, commit } from '../src/write-tools.js'
import { TOOLS } from '../src/tools.js'
import { modeOf } from '../../frontend/src/lib/history.js'

const byName = Object.fromEntries([...TOOLS, ...WRITE_TOOLS].map(t => [t.name, t]))
const BENCH = '0025'          // barbell bench press
const ROW = '0027'            // barbell bent over row

function fakeServer(doc) {
  const srv = { doc: structuredClone(doc), rev: 7, puts: [] }
  srv.doc._wid = 'w7'
  srv.fetch = async (url, opts = {}) => {
    const route = (opts.method || 'GET') + ' ' + new URL(url).pathname
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => structuredClone(body) })
    if (opts.headers?.Authorization !== 'Bearer tok') return reply(401, { error: 'not signed in' })
    if (route === 'GET /api/me') return reply(200, { user: { id: 'u1', name: 'Camilo', admin: true } })
    if (route === 'GET /api/data/rev') return reply(200, { rev: srv.rev, wid: srv.doc._wid })
    if (route === 'GET /api/data') return reply(200, { state: { ...srv.doc, _rev: srv.rev }, rev: srv.rev })
    if (route === 'PUT /api/data') {
      const body = JSON.parse(opts.body)
      srv.puts.push(body)
      if (body.baseRev !== srv.rev || (body.baseWid && body.baseWid !== srv.doc._wid)) return reply(409, { error: 'conflict', rev: srv.rev, state: srv.doc })
      srv.rev++
      srv.doc = { ...body.state, _wid: 'w' + srv.rev }
      return reply(200, { rev: srv.rev, wid: srv.doc._wid })
    }
    return reply(404, { error: 'not found' })
  }
  // Another device saving between the MCP's read and its write.
  srv.phoneSaves = mutate => { mutate(srv.doc); srv.rev++; srv.doc._wid = 'w' + srv.rev }
  return srv
}

let srv
const run = async (name, params = {}) => {
  const tool = byName[name]
  const parsed = z.object(tool.schema).parse(params)
  await refresh()
  return tool.handler(parsed)
}
const routineByName = n => srv.doc.routines.find(r => r.name === n)

beforeEach(async () => {
  const seed = buildDemoState()
  seed.unit = 'kg'
  seed._ts = 1000
  srv = fakeServer(seed)
  await initApi(createClient({ url: 'http://gym.test', token: 'tok' }, { fetchImpl: srv.fetch, onToken: () => {} }))
})

describe('create_routine', () => {
  test('adds a routine, stamped and conditional, touching nothing else', async () => {
    const before = structuredClone(srv.doc)
    const res = await run('create_routine', {
      name: 'Torso A',
      progression: 'double',
      exercises: [
        { exercise_id: BENCH, sets: 3, reps: 10, reps_min: 6, weight: 80, rest_sec: 150 },
        { exercise_id: ROW, sets: 3, reps: 12, reps_min: 8 }
      ]
    })
    expect(srv.puts).toHaveLength(1)
    const put = srv.puts[0]
    expect(put).toMatchObject({ stamped: true, baseRev: 7, baseWid: 'w7' })
    const r = routineByName('Torso A')
    expect(r.prog).toBe('double')
    expect(r.ex.map(e => e.id)).toEqual([BENCH, ROW])
    expect(r.ex[0]).toMatchObject({ sets: 3, reps: 10, repsMin: 6, weight: 80, restSec: 150, mode: 'reps' })
    expect(r.id).toBeTruthy()
    expect(srv.doc.routines).toHaveLength(before.routines.length + 1)
    for (const k of ['workouts', 'bodyweight', 'exWeights', 'week', 'unit']) expect(srv.doc[k]).toEqual(before[k])
    expect(srv.doc._ts).toBeGreaterThan(1000)
    expect(res.state_version).toBe(8)
    expect(res.created.routine_id).toBe(r.id)
  })

  test('refuses an exercise id that does not resolve, without writing', async () => {
    await expect(run('create_routine', { name: 'X', exercises: [{ exercise_id: 'nope-123' }] }))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(srv.puts).toHaveLength(0)
  })

  test('double progression without a rep range is refused', async () => {
    await expect(run('create_routine', { name: 'X', progression: 'double', exercises: [{ exercise_id: BENCH, reps: 10 }] }))
      .rejects.toMatchObject({ code: 'EINVAL' })
    expect(srv.puts).toHaveLength(0)
  })

  test('links supersets to the previous exercise', async () => {
    await run('create_routine', {
      name: 'SS', exercises: [{ exercise_id: BENCH }, { exercise_id: ROW, superset_with_previous: true }]
    })
    const [a, b] = routineByName('SS').ex
    expect(a.sg).toBeTruthy()
    expect(b.sg).toBe(a.sg)
  })

  test('a device that saved in between: nothing written, no retry', async () => {
    await refresh()
    const tool = byName.create_routine
    const params = z.object(tool.schema).parse({ name: 'Late', exercises: [{ exercise_id: BENCH }] })
    srv.phoneSaves(d => { d.restSec = 120 })
    await expect(tool.handler(params)).rejects.toMatchObject({ code: 'ECONFLICT' })
    expect(srv.puts).toHaveLength(1)
    expect(routineByName('Late')).toBeUndefined()
    expect(srv.doc.restSec).toBe(120)
    expect(getState().restSec).toBe(120)
  })
})

describe('edit_routine', () => {
  test('keeps the id and the settings it cannot express; null clears', async () => {
    const r0 = srv.doc.routines[0]
    const keep = r0.ex[0]
    keep.warmupSets = 2
    keep.restSec = 200
    srv.phoneSaves(() => {})
    await refresh()
    const version = stateVersion()
    await run('edit_routine', {
      routine_id: r0.id, expected_version: version, name: 'Renamed',
      exercises: [{ exercise_id: keep.id, sets: 5, rest_sec: null }, { exercise_id: ROW }]
    })
    const r = srv.doc.routines.find(x => x.id === r0.id)
    expect(r.name).toBe('Renamed')
    expect(r.ex[0]).toMatchObject({ id: keep.id, sets: 5, warmupSets: 2 })
    expect(r.ex[0].restSec).toBeUndefined()
    expect(r.ex[1].id).toBe(ROW)
  })

  test('a stale expected_version is refused before anything is sent', async () => {
    const r0 = srv.doc.routines[0]
    await expect(run('edit_routine', {
      routine_id: r0.id, expected_version: 3, name: 'X', exercises: [{ exercise_id: BENCH }]
    })).rejects.toMatchObject({ code: 'ECONFLICT' })
    expect(srv.puts).toHaveLength(0)
  })
})

describe('delete_routine and set_week_plan', () => {
  test('delete needs confirm: true and removes the routine from the week', async () => {
    const r0 = srv.doc.routines[0]
    srv.doc.week = { 1: [r0.id] }
    srv.phoneSaves(() => {})
    expect(() => z.object(byName.delete_routine.schema).parse({ routine_id: r0.id, expected_version: 8 })).toThrow()
    await run('delete_routine', { routine_id: r0.id, expected_version: 8, confirm: true })
    expect(srv.doc.routines.some(r => r.id === r0.id)).toBe(false)
    expect(srv.doc.week[1]).toBeUndefined()
    expect(srv.doc.workouts.length).toBeGreaterThan(0)
  })

  test('sets and clears weekdays, refusing unknown routines', async () => {
    const [a, b] = srv.doc.routines
    const res = await run('set_week_plan', { expected_version: 7, days: [{ weekday: 1, routine_ids: [a.id, b.id] }, { weekday: 2, routine_ids: [] }] })
    expect(srv.doc.week[1]).toEqual([a.id, b.id])
    expect(srv.doc.week[2]).toBeUndefined()
    expect(res.week.find(d => d.weekday === 1).routine_names).toEqual([a.name, b.name])
    await expect(run('set_week_plan', { expected_version: 8, days: [{ weekday: 3, routine_ids: ['ghost'] }] }))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('guard and search', () => {
  test('a change that would touch the history is refused', async () => {
    await expect(commit(null, S => { S.workouts.pop() })).rejects.toMatchObject({ code: 'EGUARD' })
    expect(srv.puts).toHaveLength(0)
  })

  test('search_exercises returns usable ids', async () => {
    const res = await run('search_exercises', { query: 'barbell bench press' })
    expect(res.results.some(e => e.id === BENCH)).toBe(true)
  })
})

// A routine weight the history overrode (a lift imported from years ago at another load) has to
// be settable for the next session — once — and a weight resent unchanged must not pin anything.
describe('pinning the next session\'s weight', () => {
  // A routine slot the demo history has trained, and the weight that history would open it at.
  const trained = () => {
    for (const r of srv.doc.routines) {
      for (const [i, c] of r.ex.entries()) {
        if (modeOf(c) !== 'reps') continue
        if (srv.doc.workouts.some(w => w.entries.some(e => e.id === c.id && e.sets.some(s => s.done && s.w > 0)))) return { r, i, c }
      }
    }
    throw new Error('no trained slot in the demo seed')
  }

  test('set_next_weight stores the weight, pins it, and reports what the session opens at', async () => {
    const { r, i, c } = trained()
    const before = structuredClone(srv.doc)
    const weight = 41.25   // a load the demo history never opens at
    const res = await run('set_next_weight', { routine_id: r.id, expected_version: 7, exercise_id: c.id, weight })
    const slot = routineByName(r.name).ex[i]
    expect(slot.weight).toBe(weight)
    expect(slot.weightAt).toBeGreaterThan(0)
    expect(res).toMatchObject({ routine_id: r.id, position: i + 1, exercise_id: c.id, pinned: true, weight, state_version: 8 })
    expect(res.opens_at).toMatchObject({ weight, weight_source: 'routine_plan' })
    expect(res.opens_at.why).toMatch(/^Weight set on the routine to /)
    for (const k of ['workouts', 'bodyweight', 'exWeights', 'week', 'unit']) expect(srv.doc[k]).toEqual(before[k])

    // null cancels the pin and leaves the weight: history decides again.
    const off = await run('set_next_weight', { routine_id: r.id, expected_version: 8, exercise_id: c.id, weight: null })
    expect(routineByName(r.name).ex[i].weightAt).toBeUndefined()
    expect(routineByName(r.name).ex[i].weight).toBe(weight)
    expect(off.pinned).toBe(false)
    expect(off.opens_at.why).not.toMatch(/^Weight set on the routine/)
  })

  test('refuses an exercise the routine does not have, a twin without a position, and a stale version', async () => {
    const { r } = trained()
    const missing = [BENCH, ROW].find(id => !r.ex.some(c => c.id === id))
    await expect(run('set_next_weight', { routine_id: r.id, expected_version: 7, exercise_id: missing, weight: 40 }))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(run('set_next_weight', { routine_id: r.id, expected_version: 3, exercise_id: r.ex[0].id, weight: 40 }))
      .rejects.toMatchObject({ code: 'ECONFLICT' })
    expect(srv.puts).toHaveLength(0)

    const { created } = await run('create_routine', { name: 'Twice', exercises: [{ exercise_id: BENCH }, { exercise_id: ROW }, { exercise_id: BENCH }] })
    await expect(run('set_next_weight', { routine_id: created.routine_id, expected_version: 8, exercise_id: BENCH, weight: 40 }))
      .rejects.toMatchObject({ code: 'EINVAL' })
    await expect(run('set_next_weight', { routine_id: created.routine_id, expected_version: 8, exercise_id: BENCH, position: 2, weight: 40 }))
      .rejects.toMatchObject({ code: 'EINVAL' })
    const res = await run('set_next_weight', { routine_id: created.routine_id, expected_version: 8, exercise_id: BENCH, position: 3, weight: 40 })
    const ex = routineByName('Twice').ex
    expect(res.position).toBe(3)
    expect(ex[2]).toMatchObject({ weight: 40 })
    expect(ex[2].weightAt).toBeGreaterThan(0)
    expect(ex[0].weightAt).toBeUndefined()
  })

  test('edit_routine pins a weight that changes, and not one resent unchanged', async () => {
    const { r, i, c } = trained()
    const resend = r.ex.map(x => ({ exercise_id: x.id, ...(modeOf(x) !== 'cardio' && x.weight != null ? { weight: x.weight } : {}) }))
    await run('edit_routine', { routine_id: r.id, expected_version: 7, name: r.name, exercises: resend })
    expect(routineByName(r.name).ex.some(x => x.weightAt)).toBe(false)

    resend[i] = { ...resend[i], weight: (c.weight || 0) + 41.25 }
    await run('edit_routine', { routine_id: r.id, expected_version: 8, name: r.name, exercises: resend })
    const ex = routineByName(r.name).ex
    expect(ex[i]).toMatchObject({ weight: (c.weight || 0) + 41.25 })
    expect(ex[i].weightAt).toBeGreaterThan(0)
    expect(ex.filter(x => x.weightAt)).toHaveLength(1)
  })

  test('create_routine pins the weights it is given, and only those', async () => {
    await run('create_routine', { name: 'Fresh', exercises: [{ exercise_id: BENCH, weight: 60 }, { exercise_id: ROW }] })
    const [bench, row] = routineByName('Fresh').ex
    expect(bench.weightAt).toBeGreaterThan(0)
    expect(row.weightAt).toBeUndefined()
  })
})
