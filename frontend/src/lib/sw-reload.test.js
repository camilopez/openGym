import { describe, it, expect, vi } from 'vitest'
import { startStaleReload, shouldReload, busyWith, RESUME_GRACE_MS, CHECK_EVERY_MS } from './sw-reload.js'

// A service worker container and a document, as far as the module touches them.
function page({ controlled = true, hidden = false } = {}) {
  const on = (t, cbs) => { t.addEventListener = (k, f) => (cbs[k] ||= []).push(f); t.removeEventListener = (k, f) => { cbs[k] = (cbs[k] || []).filter(x => x !== f) } }
  const swCbs = {}, docCbs = {}
  const update = vi.fn(() => Promise.resolve())
  const sw = { controller: controlled ? {} : null, getRegistration: vi.fn(() => Promise.resolve({ update })) }
  const doc = { visibilityState: hidden ? 'hidden' : 'visible' }
  on(sw, swCbs); on(doc, docCbs)
  let t = 1_000_000
  const p = {
    sw, doc, update,
    busy: false,
    reload: vi.fn(),
    now: () => t,
    advance: ms => { t += ms },
    takeOver: () => (swCbs.controllerchange || []).forEach(f => f()),
    hide: () => { doc.visibilityState = 'hidden'; (docCbs.visibilitychange || []).forEach(f => f()) },
    show: () => { doc.visibilityState = 'visible'; (docCbs.visibilitychange || []).forEach(f => f()) },
  }
  p.stop = startStaleReload({ sw, doc, isBusy: () => p.busy, reload: p.reload, now: p.now })
  return p
}

describe('reloading a page that runs an older build', () => {
  it('reloads a page resumed onto a deploy, before anything is started there (2026-10-19)', async () => {
    // Loaded before the deploy, put away, brought back at the gym the next morning.
    const p = page()
    p.advance(RESUME_GRACE_MS * 5)
    p.hide()
    p.advance(3 * 86400000)
    p.show()
    await Promise.resolve(); await Promise.resolve()
    expect(p.update).toHaveBeenCalledTimes(1)     // a resumed page never navigates: it has to ask
    p.advance(2000)
    p.takeOver()                                  // the new worker installed and took over
    expect(p.reload).toHaveBeenCalledTimes(1)
  })

  it('does not count the first worker taking over a page that had none', () => {
    const p = page({ controlled: false })
    p.takeOver()
    expect(p.reload).not.toHaveBeenCalled()
    p.takeOver()                                  // the next one is a newer build
    expect(p.reload).toHaveBeenCalledTimes(1)
  })

  it('never reloads during a workout, a sheet or an edit; it waits for the next quiet moment', () => {
    const p = page()
    p.busy = true
    p.takeOver()
    p.hide(); p.show()
    expect(p.reload).not.toHaveBeenCalled()
    p.busy = false                                // the workout is finished
    p.hide()
    expect(p.reload).toHaveBeenCalledTimes(1)
  })

  it('waits for the next resume when the new build lands while the page is in use', () => {
    const p = page()
    p.advance(RESUME_GRACE_MS + 1)
    p.takeOver()
    expect(p.reload).not.toHaveBeenCalled()
    p.hide()
    expect(p.reload).toHaveBeenCalledTimes(1)
  })

  it('asks for a new worker at most once a minute', async () => {
    const p = page()
    p.hide(); p.show(); p.hide(); p.show()
    await Promise.resolve(); await Promise.resolve()
    expect(p.update).toHaveBeenCalledTimes(1)
    p.advance(CHECK_EVERY_MS)
    p.hide(); p.show()
    await Promise.resolve(); await Promise.resolve()
    expect(p.update).toHaveBeenCalledTimes(2)
  })

  it('stops listening when stopped', () => {
    const p = page()
    p.stop()
    p.takeOver(); p.hide()
    expect(p.reload).not.toHaveBeenCalled()
  })
})

describe('shouldReload and busyWith', () => {
  it('needs a newer build, nothing open, and a moment nobody is looking', () => {
    const base = { stale: true, busy: false, hidden: false, resumedAt: 0, now: 0 }
    expect(shouldReload(base)).toBe(true)
    expect(shouldReload({ ...base, stale: false })).toBe(false)
    expect(shouldReload({ ...base, busy: true, hidden: true })).toBe(false)
    expect(shouldReload({ ...base, now: RESUME_GRACE_MS + 1 })).toBe(false)
    expect(shouldReload({ ...base, resumedAt: null })).toBe(false)
    expect(shouldReload({ ...base, resumedAt: null, hidden: true })).toBe(true)
  })

  it('counts a workout in progress, an open sheet, the routine editor and the coach as busy', () => {
    expect(busyWith({ S: {}, sheets: [], hash: '#/home' })).toBe(false)
    expect(busyWith({ S: { active: { id: 'w' } }, sheets: [], hash: '#/workout' })).toBe(true)
    expect(busyWith({ S: {}, sheets: [{ id: 1 }], hash: '#/home' })).toBe(true)
    expect(busyWith({ S: {}, sheets: [], hash: '#/plan/r/abc' })).toBe(true)
    expect(busyWith({ S: {}, sheets: [], hash: '#/coach' })).toBe(true)
    expect(busyWith({ S: {}, sheets: [], hash: '#/plan' })).toBe(false)
  })
})
