/* Write tools over the paired API (fork: homelab bridge until upstream's write tools land, #116).
   Every write is built the way the app builds the same change and goes out the way the app
   pushes it:
     - routines are validated and normalised by the plan-file import (parsePlan/mergePlan in
       lib/plan-share.js), so an exercise id that does not resolve is refused instead of saved;
     - the change is stamped with stampChange (lib/sync-merge.js), as store.update does, so the
       phone's merge treats it like an edit made on another device;
     - PUT /api/data is conditional on the revision just read (baseRev/baseWid). A 409 means a
       device saved in between: nothing is written and the caller is told to read again;
     - before sending, the document is checked to differ from the server's only in the plan:
       workouts, weigh-ins, measurements, lift weights and unit must be byte-for-byte the same.
   Edits, deletions and schedule changes also require `expected_version` — the state_version a
   read returned — so a plan the user changed on the phone since is never overwritten blind. */
import { z } from 'zod'
import { getState, getSnapshot, getClient, refresh } from './state.js'
import { exLine } from './labels.js'
import { EXIDX, canonicalExId, allExercises, searchExercises, exOr } from '../../frontend/src/lib/exercises.js'
import { defaultConfig, modeOf, cleanupSg } from '../../frontend/src/lib/history.js'
import { POLICIES_FOR, POLICY_NAME } from '../../frontend/src/lib/progression.js'
import { parsePlan, mergePlan } from '../../frontend/src/lib/plan-share.js'
import { deleteRoutine } from '../../frontend/src/lib/routines.js'
import { stampChange } from '../../frontend/src/lib/sync-merge.js'
import { uid } from '../../frontend/src/lib/format.js'

const fail = (code, message) => Object.assign(new Error(message), { code })
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)

/* ---------- commit: read → mutate → stamp → guard → conditional PUT ---------- */

// What a plan change may never touch. Compared as JSON, so any difference refuses the write.
const UNTOUCHED = ['workouts', 'bodyweight', 'measurements', 'exWeights', 'unit']

export async function commit(expectedVersion, mutate) {
  const { state: cur, rev, wid } = getSnapshot()
  if (!cur) throw fail('ENOSTATE', 'this profile has no synced state yet — open openGym on a signed-in device once, then retry')
  if (expectedVersion != null && expectedVersion !== rev) {
    throw fail('ECONFLICT', `the profile changed since it was read (state_version ${expectedVersion}, now ${rev}) — read it again before writing`)
  }
  const S = structuredClone(cur)
  if (!Array.isArray(S.routines)) S.routines = []
  if (!isMap(S.week)) S.week = {}
  if (!Array.isArray(S.customEx)) S.customEx = []
  const result = mutate(S)
  S._ts = stampChange(cur, S, Date.now())
  for (const k of UNTOUCHED) {
    if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(S[k] ?? null)) {
      throw fail('EGUARD', `refusing to write: the change would also alter "${k}"`)
    }
  }
  try {
    await getClient().put(S, rev, wid)
  } catch (e) {
    if (e.code === 'ECONFLICT') {
      await refresh(true)
      throw fail('ECONFLICT', 'another device saved changes at the same moment — nothing was written; read the plan again and retry')
    }
    throw e
  }
  await refresh(true)
  return { ...result, state_version: getSnapshot().rev }
}

/* ---------- exercise slot → routine config ---------- */

const POLICY = z.enum(['off', 'linear', 'greyskull', 'double', 'triple', 'time'])
const nullable = t => t.nullable().optional()

export const slotSchema = z.object({
  exercise_id: z.string().min(1).describe('Exercise id from search_exercises (library or the user\'s own exercise).'),
  mode: z.enum(['reps', 'time', 'cardio']).optional().describe('How the exercise is logged. Defaults to the exercise\'s own (cardio for cardio machines, else reps).'),
  sets: z.number().int().min(1).max(20).optional().describe('Working sets (the minimum sets under triple progression). Default 3.'),
  reps: z.number().int().min(1).max(100).optional().describe('Reps per set; under double/triple progression the TOP of the rep range.'),
  reps_min: nullable(z.number().int().min(1).max(100)).describe('Bottom of the rep range (double/triple progression). Must be below reps. null clears it.'),
  sets_max: nullable(z.number().int().min(2).max(10)).describe('Triple progression: the most sets the exercise climbs to. Must be above sets. null clears it.'),
  weight: nullable(z.number().min(0).max(1000)).describe('Starting weight in the profile\'s unit (0 or omitted: the app starts from the last logged session). For bodyweight exercises, added load.'),
  sec: z.number().int().min(5).max(3600).optional().describe('Time mode: seconds per set.'),
  min: z.number().min(1).max(600).optional().describe('Cardio: minutes.'),
  speed: z.number().min(0).max(50).optional().describe('Cardio: speed.'),
  rest_sec: nullable(z.number().int().min(10).max(900)).describe('This exercise\'s own rest; omitted/null uses the global rest timer.'),
  progression: nullable(POLICY).describe('Per-exercise progression rule overriding the routine\'s. null removes the override.'),
  increment: nullable(z.number().positive().max(50)).describe('Weight step when the exercise progresses; omitted uses the app\'s default for the equipment.'),
  last_to_failure: z.boolean().optional().describe('Prescribe the last set to failure.'),
  superset_with_previous: z.boolean().optional().describe('Link this exercise into a superset with the one before it.'),
  note: nullable(z.string().max(280)).describe('A note shown with the exercise.')
}).strict()

function resolveExercise(rawId, S) {
  const id = canonicalExId(rawId)
  const custom = S.customEx.find(c => c.id === id)
  if (!EXIDX[id] && !custom) throw fail('ENOENT', `no exercise with id ${JSON.stringify(rawId)} — use search_exercises to find the id`)
  return { id, custom }
}

const set = (o, k, v) => { if (v === null) delete o[k]; else if (v !== undefined) o[k] = v }

// `base` is the slot this one replaces (edit_routine), so settings the app has and this schema
// does not (warm-up sets, pyramids, drop sets, dumbbell load…) survive an edit untouched.
function slotConfig(spec, S, routinePolicy, base) {
  const { id } = resolveExercise(spec.exercise_id, S)
  const fresh = defaultConfig(id, spec.mode)
  const cfg = base && base.id === id && (!spec.mode || modeOf(base) === spec.mode)
    ? structuredClone(base)
    : { id, ...fresh }
  cfg.id = id
  delete cfg.sg
  const mode = spec.mode || modeOf(cfg)
  if (mode !== 'cardio') cfg.mode = mode
  if (spec.sets !== undefined) cfg.sets = spec.sets
  if (mode === 'reps') {
    if (spec.reps !== undefined) cfg.reps = spec.reps
    set(cfg, 'repsMin', spec.reps_min)
    set(cfg, 'setsMax', spec.sets_max)
    set(cfg, 'weight', spec.weight)
  } else if (mode === 'time') {
    if (spec.sec !== undefined) cfg.sec = spec.sec
    set(cfg, 'weight', spec.weight)
  } else {
    if (spec.min !== undefined) cfg.min = spec.min
    if (spec.speed !== undefined) cfg.speed = spec.speed
  }
  set(cfg, 'restSec', spec.rest_sec)
  set(cfg, 'prog', spec.progression)
  set(cfg, 'inc', spec.increment)
  set(cfg, 'note', spec.note)
  if (spec.last_to_failure === true) cfg.lastToFailure = true
  else if (spec.last_to_failure === false) delete cfg.lastToFailure

  const name = exOr(id).n
  const policy = cfg.prog || (mode === 'reps' ? routinePolicy || 'linear' : mode === 'time' ? 'time' : 'off')
  if (!POLICIES_FOR[mode].includes(policy)) {
    throw fail('EINVAL', `${name}: "${policy}" is not a progression for ${mode} exercises (use one of ${POLICIES_FOR[mode].join(', ')})`)
  }
  if ((policy === 'double' || policy === 'triple') && !(cfg.repsMin > 0 && cfg.repsMin < cfg.reps)) {
    throw fail('EINVAL', `${name}: ${POLICY_NAME[policy].toLowerCase()} needs a rep range — reps_min below reps (e.g. reps_min 8, reps 12)`)
  }
  if (cfg.repsMin != null && !(cfg.repsMin < cfg.reps)) throw fail('EINVAL', `${name}: reps_min must be below reps`)
  if (policy === 'triple' && !(cfg.setsMax > (cfg.sets || 1))) throw fail('EINVAL', `${name}: triple progression needs sets_max above sets`)
  if (cfg.setsMax != null && policy !== 'triple') delete cfg.setsMax
  return cfg
}

function buildSlots(specs, S, routinePolicy, oldEx = []) {
  // The nth occurrence of an exercise replaces the nth occurrence in the old list.
  const seen = new Map()
  const ex = specs.map(spec => {
    const id = canonicalExId(spec.exercise_id)
    const n = seen.get(id) || 0
    seen.set(id, n + 1)
    const base = oldEx.filter(e => e.id === id)[n]
    return slotConfig(spec, S, routinePolicy, base)
  })
  specs.forEach((spec, i) => {
    if (!spec.superset_with_previous) return
    if (i === 0) throw fail('EINVAL', 'the first exercise cannot be in a superset with a previous one')
    const gid = ex[i - 1].sg || ('sg' + uid())
    ex[i - 1].sg = gid
    ex[i].sg = gid
  })
  cleanupSg(ex)
  return ex
}

// The plan-file import is the app's door for routines written elsewhere: it resolves every id,
// clamps the numbers and converts nothing (the bundle is in the profile's own unit).
function validated(S, routine) {
  const usedCustom = S.customEx.filter(c => routine.ex.some(e => e.id === c.id))
  const parsed = parsePlan({
    opengym_plan: 1, unit: S.unit || 'kg', name: '', week: {},
    routines: [{ id: 'mcp', ...routine }], customEx: usedCustom
  }, S.unit || 'kg')
  if (parsed.dropped) throw fail('EINVAL', `${parsed.dropped} exercise(s) did not resolve to the library or the user's exercises`)
  return parsed
}

function routineView(r, S) {
  return {
    routine_id: r.id,
    name: r.name,
    progression: r.prog || 'linear',
    deload_routine: r.excludeFromProgression === true,
    exercises: r.ex.map((cfg, i) => ({
      position: i + 1,
      exercise_id: cfg.id,
      name: (S.customEx.find(c => c.id === cfg.id) || exOr(cfg.id)).n,
      summary: exLine(cfg, S.unit || 'kg'),
      ...(cfg.prog ? { progression: cfg.prog } : {}),
      ...(cfg.restSec ? { rest_sec: cfg.restSec } : {}),
      ...(cfg.sg ? { superset_group: cfg.sg } : {})
    }))
  }
}

const routineFields = {
  name: z.string().trim().min(1).max(60).describe('Routine name as shown on the Plan screen.'),
  progression: z.enum(['off', 'linear', 'greyskull', 'double', 'triple']).optional()
    .describe('Routine-wide progression for rep exercises (default linear). double/triple need reps_min on each rep exercise.'),
  deload_routine: z.boolean().optional().describe('A deload routine: its workouts never count as the baseline progression continues from.'),
  exercises: z.array(slotSchema).min(1).max(30).describe('The exercises in order.')
}

/* ---------- tools ---------- */

export const searchExercisesTool = {
  name: 'search_exercises',
  description: 'Search the exercise library (1,300+ built-ins) and the user\'s own exercises by name, muscle or equipment. Returns ids to use in create_routine / edit_routine. Prefer exercises the user has logged before (see list_workouts / estimate_1rm) when one fits.',
  schema: {
    query: z.string().trim().min(2).describe('e.g. "incline bench barbell", "lat pulldown", "calf"'),
    body_part: z.string().optional().describe('Filter: body part as returned (e.g. "chest", "back", "upper legs").'),
    limit: z.number().int().min(1).max(50).optional()
  },
  handler: ({ query, body_part, limit = 15 }) => {
    const S = getState() || { customEx: [] }
    let list = searchExercises(allExercises(S), query)
    if (body_part) list = list.filter(e => (e.bp || '').toLowerCase() === body_part.toLowerCase())
    return {
      results: list.slice(0, limit).map(e => ({
        id: e.id,
        name: e.n,
        body_part: e.bp || null,
        target: e.tg || null,
        equipment: e.eq || null,
        mode: modeOf({ id: e.id }),
        ...(e.custom ? { own_exercise: true } : {})
      })),
      total_matches: list.length
    }
  }
}

export const createRoutine = {
  name: 'create_routine',
  description: 'Create a NEW routine in the user\'s openGym plan (it appears on the Plan screen of every device within ~30 s). Nothing existing is changed. Validate exercise ids with search_exercises first. Weights are in the profile\'s unit (see list_routines `unit`); omit weight to let the app start from the last logged session of that exercise. Show the user the routine and get their OK before calling this.',
  schema: { ...routineFields },
  handler: async ({ name, progression, deload_routine, exercises }) => commit(null, S => {
    const ex = buildSlots(exercises, S, progression)
    const parsed = validated(S, {
      name, ...(progression && progression !== 'linear' ? { prog: progression } : {}),
      ...(deload_routine ? { excludeFromProgression: true } : {}), ex
    })
    const before = new Set(S.routines.map(r => r.id))
    mergePlan(S, parsed)
    const r = S.routines.find(x => !before.has(x.id))
    return { created: routineView(r, S) }
  })
}

export const editRoutine = {
  name: 'edit_routine',
  description: 'Replace a routine\'s name, progression and exercise list (the routine keeps its id, so its history, weekday assignments and session progression stay attached). Send the FULL exercise list in the new order. For an exercise that stays, omitted fields keep their current value and settings this tool cannot express (warm-up sets, pyramids, drop sets) are preserved; pass null to clear a field. Requires expected_version from the read the edit is based on (get_routine).',
  schema: {
    routine_id: z.string().min(1),
    expected_version: z.number().int().min(0).describe('state_version returned by the read this edit is based on.'),
    ...routineFields
  },
  handler: async ({ routine_id, expected_version, name, progression, deload_routine, exercises }) => commit(expected_version, S => {
    const r = S.routines.find(x => x.id === routine_id)
    if (!r) throw fail('ENOENT', `no routine with id ${JSON.stringify(routine_id)}`)
    const policy = progression ?? r.prog
    const ex = buildSlots(exercises, S, policy, r.ex || [])
    const parsed = validated(S, { name, ex })
    r.name = name
    r.ex = parsed.routines[0].ex
    if (progression !== undefined) { if (progression === 'linear') delete r.prog; else r.prog = progression }
    if (deload_routine === true) r.excludeFromProgression = true
    else if (deload_routine === false) delete r.excludeFromProgression
    return { updated: routineView(r, S) }
  })
}

export const deleteRoutineTool = {
  name: 'delete_routine',
  description: 'Delete a routine from the plan. Its logged workouts stay in the history; it is removed from every weekday and date override that names it. Requires confirm: true (ask the user first) and expected_version.',
  schema: {
    routine_id: z.string().min(1),
    expected_version: z.number().int().min(0),
    confirm: z.literal(true).describe('Must be true: the user confirmed the deletion.')
  },
  handler: async ({ routine_id, expected_version }) => commit(expected_version, S => {
    const r = S.routines.find(x => x.id === routine_id)
    if (!r) throw fail('ENOENT', `no routine with id ${JSON.stringify(routine_id)}`)
    const dropped = deleteRoutine(S, routine_id)
    return { deleted: { routine_id, name: r.name }, date_overrides_removed: Object.keys(dropped) }
  })
}

export const setWeekPlan = {
  name: 'set_week_plan',
  description: 'Assign routines to weekdays in the user\'s weekly plan. Only the weekdays listed change; an empty routine_ids makes that day a rest day. Weekdays use JS getDay(): Sunday=0, Monday=1 … Saturday=6. A day may hold several routines (done together). Requires expected_version.',
  schema: {
    expected_version: z.number().int().min(0),
    days: z.array(z.object({
      weekday: z.number().int().min(0).max(6),
      routine_ids: z.array(z.string().min(1)).max(4)
    }).strict()).min(1).max(7)
  },
  handler: async ({ expected_version, days }) => commit(expected_version, S => {
    if (new Set(days.map(d => d.weekday)).size !== days.length) throw fail('EINVAL', 'each weekday may appear only once')
    for (const { weekday, routine_ids } of days) {
      for (const id of routine_ids) if (!S.routines.some(r => r.id === id)) throw fail('ENOENT', `no routine with id ${JSON.stringify(id)}`)
      if (routine_ids.length) S.week[weekday] = [...routine_ids]
      else delete S.week[weekday]
    }
    const nameOf = id => S.routines.find(r => r.id === id)?.name
    return {
      week: [1, 2, 3, 4, 5, 6, 0].map(d => {
        const ids = [].concat(S.week[d] || [])
        return { weekday: d, weekday_name: DAY_NAMES[d], routine_ids: ids, routine_names: ids.map(nameOf) }
      })
    }
  })
}

export const WRITE_TOOLS = [searchExercisesTool, createRoutine, editRoutine, deleteRoutineTool, setWeekPlan]
