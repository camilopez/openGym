// A page keeps running the bundle it loaded, whatever the server serves since. A new service
// worker installs and takes over the page's requests, but the code already in memory stays: and
// a home-screen app on iOS is not reloaded when it comes back to the front, it is resumed. One
// opened before a deploy went on running the old build for days — on 2026-10-19 it started a
// session with the progression of the release before (no pinned weights), while the phone showed
// the new version the next time it actually loaded. A resumed page never navigates either, which
// is the only moment iOS looks for a new worker on its own.
//
// So: every time the app comes back to the front it asks for a new worker, and once one has taken
// over (a deploy since this page loaded) the page reloads at the first moment that costs nothing
// — hidden, or right after it was resumed — and never while something is open that a reload would
// throw away: a workout in progress, a sheet, the routine editor, the coach. The state itself is
// on the device already (localStorage, written on every change, and what the server is owed is
// marked as such), so a reload loses nothing that was saved.

// How long after coming back to the front a new build still counts as "just resumed": the update
// check and the new worker's install take a second or two, and nobody has started anything yet.
export const RESUME_GRACE_MS = 10000
// The update check is cheap but not free; a phone flicking between apps does not need one each time.
export const CHECK_EVERY_MS = 60000

const UNSAVED_ROUTES = [/^#\/plan\/r\//, /^#\/coach(?:\/|$)/]

/** Whether a reload now would throw away something the user has open. */
export function busyWith({ S, sheets, hash } = {}) {
  if (S?.active) return true
  if (Array.isArray(sheets) && sheets.length) return true
  return UNSAVED_ROUTES.some(re => re.test(hash || ''))
}

/**
 * Whether to reload for a newer build: only once one has taken over, never while busy, and only
 * while hidden or within the grace after being resumed — otherwise it waits for the next resume.
 */
export function shouldReload({ stale, busy, hidden, resumedAt, now }) {
  if (!stale || busy) return false
  if (hidden) return true
  return resumedAt != null && now - resumedAt <= RESUME_GRACE_MS
}

/**
 * Wires the rule to the page. `sw` is navigator.serviceWorker, `doc` the document; `isBusy` reads
 * the app's state, `reload` reloads. Returns a function that removes the listeners.
 */
export function startStaleReload({ sw, doc, isBusy, reload, now = () => Date.now() }) {
  if (!sw || !doc) return () => {}
  // The first worker taking over a page that had none is an install, not a newer build.
  let controlled = !!sw.controller
  let stale = false
  let resumedAt = now()   // a fresh load is as good as a resume: nothing has been started yet
  let checkedAt = -Infinity
  let done = false

  const maybeReload = () => {
    if (done) return
    if (shouldReload({ stale, busy: !!isBusy(), hidden: doc.visibilityState === 'hidden', resumedAt, now: now() })) {
      done = true
      reload()
    }
  }
  const check = () => {
    if (now() - checkedAt < CHECK_EVERY_MS) return
    checkedAt = now()
    Promise.resolve(sw.getRegistration?.()).then(reg => reg?.update?.()).catch(() => {})
  }
  const onController = () => {
    if (!controlled) { controlled = true; return }
    stale = true
    maybeReload()
  }
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') {
      resumedAt = now()
      maybeReload()
      if (!done) check()
    } else {
      resumedAt = null
      maybeReload()
    }
  }
  sw.addEventListener('controllerchange', onController)
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    sw.removeEventListener('controllerchange', onController)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
