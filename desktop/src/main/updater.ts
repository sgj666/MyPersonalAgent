import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
// electron-updater is CommonJS: its members live on module.exports, with no
// meaningful default export. Under module=commonjs + esModuleInterop, a named
// import compiles to `electron_updater_1.autoUpdater` and resolves correctly,
// whereas `import pkg from 'electron-updater'` yields undefined.
import { autoUpdater } from 'electron-updater'
import { loadAppConfig } from './themes'

// Status payloads pushed to the renderer over the 'update-status' channel.
// The renderer drives the NavRail badge + update panel from these.
export type UpdateStatus =
  | { state: 'checking' }
  // userInitiated: the check came from an explicit "check for update" click
  // (not the startup/interval poll). The renderer uses this to decide whether
  // to auto-open the panel: automatic checks stay silent (dot only) once a
  // version was dismissed; a manual check always re-opens.
  | { state: 'available'; version: string; notes?: string; userInitiated?: boolean }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

let getWindow: () => BrowserWindow | null = () => null

// Legacy Windows (7/8/8.1) runs the separate Electron-22 build, which must
// update to OTHER legacy builds — never the standard build (Electron 33 won't
// launch on Win7). The update Function serves that build under /update/legacy/.
// We detect the old OS at runtime (os.release() reports the Windows NT version:
// 6.1 = Win7, 6.2/6.3 = Win8/8.1, 10.x = Win10/11) rather than via a build
// flag, so the same source serves the right feed on whatever it runs on.
function isLegacyWindows(): boolean {
  if (process.platform !== 'win32') return false
  const major = Number((os.release() || '').split('.')[0])
  // NT 6.x = Win7/8/8.1; NT 10.x = Win10/11. Old = major < 10.
  return Number.isFinite(major) && major < 10
}

// A bundled app-config may point the updater at a different feed origin.
//
// `updateFeedUrl` accepts ONE URL or an ARRAY of URLs. The array is a failover
// list, tried in order — that is how a China-facing build keeps working when an
// accelerator mirror dies: entry 1 is a GitHub proxy prefix (ghfast.top style),
// the last entry is the direct GitHub Releases URL, so there is always a path
// left. The URL that worked is remembered across launches
// (userData/update-feed.json), so a healthy mirror is tried first next time.
//
// When set, these URLs are used as-is (the China/R2 dual-origin switching below
// belongs to the default build's own infrastructure). Absent -> default feed.
const CONFIGURED_FEEDS: string[] = (() => {
  const raw = loadAppConfig()?.updateFeedUrl
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list
    .filter((u): u is string => typeof u === 'string' && u.trim() !== '')
    .map((u) => u.trim())
})()

// A derived/fork build must NOT keep the default feed: the default feed serves
// the upstream product, so "updating" there silently replaces this build's
// frontend + bundled skills/plugins with upstream's. A build with no release
// feed of its own ships `updateFeedUrl: "off"` (or "none"/"disabled"/"false")
// to switch the updater off entirely.
const UPDATES_DISABLED = /^(off|none|disabled|false)$/i.test(CONFIGURED_FEEDS[0] || '')

// Index into CONFIGURED_FEEDS of the feed currently in use; seeded from the
// last feed that worked (see loadFeedIndex).
let activeFeed = 0

// Human-readable label for logs: the active URL plus its position in the list.
function feedLabel(): string {
  if (CONFIGURED_FEEDS.length === 0) return preferChina ? `${FEED_BASE}?lang=zh` : FEED_BASE
  const url = CONFIGURED_FEEDS[activeFeed] || CONFIGURED_FEEDS[0]
  return CONFIGURED_FEEDS.length > 1 ? `${url} [#${activeFeed + 1}/${CONFIGURED_FEEDS.length}]` : url
}

// The update feed. Both default entries hit the same Pages Function
// (https://cowagent.ai/update/); the ?lang=zh query tells it to 302 installer
// downloads to the China CDN mirror instead of R2. The feed metadata is
// identical either way, so we can freely switch the feed URL between attempts
// to fall back from one download origin to the other. Legacy Windows appends a
// /legacy/ segment so it gets the win-legacy release instead of the standard.
const FEED_BASE = 'https://cowagent.ai/update/' + (isLegacyWindows() ? 'legacy/' : '')
const feedUrlFor = (china: boolean) => {
  if (CONFIGURED_FEEDS.length) return withFeedQuery(CONFIGURED_FEEDS[activeFeed] || CONFIGURED_FEEDS[0])
  return withFeedQuery(china ? `${FEED_BASE}?lang=zh` : FEED_BASE)
}

// A channel set explicitly at build time (publish.channel) names a dedicated
// feed file, e.g. one per Windows generation. setFeedURL replaces the packaged
// app-update.yml, so that channel has to be passed along. The channel
// electron-builder derives from a pre-release version tag is left out, so
// those builds keep reading the default feed file.
let packagedChannelCache: string | null | undefined
function packagedChannel(): string | undefined {
  if (packagedChannelCache === undefined) {
    packagedChannelCache = null
    try {
      const text = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
      const channel = text.match(/^channel:\s*['"]?([\w.-]+)['"]?\s*$/m)?.[1]
      const versionTag = app.getVersion().split('-')[1]?.split('.')[0]?.toLowerCase()
      if (channel && channel !== 'latest' && channel.toLowerCase() !== versionTag) {
        packagedChannelCache = channel
      }
    } catch {
      // no packaged update config: use the default channel
    }
  }
  return packagedChannelCache ?? undefined
}

// Extra query parameters the renderer may attach to the feed URL, so a feed
// server can tailor its answer to this install. Empty unless set, in which
// case the feed URL is used exactly as above. electron-updater carries the
// feed URL's query over to the files it resolves from it.
let feedQuery: Record<string, string> = {}
const FEED_QUERY_KEY = /^[A-Za-z0-9_-]{1,32}$/
const FEED_QUERY_MAX_ENTRIES = 8
const FEED_QUERY_MAX_VALUE = 256

function withFeedQuery(url: string): string {
  const entries = Object.entries(feedQuery)
  if (entries.length === 0) return url
  try {
    const u = new URL(url)
    for (const [k, v] of entries) u.searchParams.set(k, v)
    return u.toString()
  } catch {
    return url
  }
}

// Which origin the current session prefers, derived from the app UI language
// (zh -> China mirror). Downloads that fail on the preferred origin retry once
// on the other one before surfacing an error.
let preferChina = false

// How many *other* candidates this operation has already switched to. Reset at
// the start of every check / download, so one operation may walk the whole
// failover list once and then stop.
let candidatesTried = 0

// Move to the next candidate feed; false when this operation ran out.
//   - configured list (>1): rotate to the next URL (wraps around);
//   - single configured URL: nothing to fall back to;
//   - default feed: swap the China mirror / R2 origin once.
function switchFeed(): boolean {
  if (CONFIGURED_FEEDS.length > 1) {
    if (candidatesTried >= CONFIGURED_FEEDS.length - 1) return false
    candidatesTried++
    activeFeed = (activeFeed + 1) % CONFIGURED_FEEDS.length
    applyFeedUrl()
    return true
  }
  if (CONFIGURED_FEEDS.length === 1) return false
  if (candidatesTried >= 1) return false
  candidatesTried++
  preferChina = !preferChina
  applyFeedUrl()
  return true
}

// Remember which feed worked, so the next launch starts there instead of
// rediscovering a dead mirror. Best effort: a write failure only costs one
// failed attempt next time.
function feedStatePath(): string {
  return path.join(app.getPath('userData'), 'update-feed.json')
}

function loadFeedIndex(): number {
  if (CONFIGURED_FEEDS.length < 2) return 0
  try {
    const parsed = JSON.parse(fs.readFileSync(feedStatePath(), 'utf8')) as { url?: string; index?: number }
    const savedUrl = typeof parsed?.url === 'string' ? parsed.url : ''
    const byUrl = savedUrl ? CONFIGURED_FEEDS.indexOf(savedUrl) : -1
    if (byUrl >= 0) return byUrl
    const i = Number(parsed?.index)
    return Number.isInteger(i) && i >= 0 && i < CONFIGURED_FEEDS.length ? i : 0
  } catch {
    return 0
  }
}

function saveFeedIndex(): void {
  if (CONFIGURED_FEEDS.length < 2) return
  try {
    fs.writeFileSync(
      feedStatePath(),
      JSON.stringify({ url: CONFIGURED_FEEDS[activeFeed], index: activeFeed, savedAt: new Date().toISOString() }),
    )
  } catch {
    // ignore
  }
}

function applyFeedUrl(): void {
  const url = feedUrlFor(preferChina)
  const channel = packagedChannel()
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url, ...(channel ? { channel } : {}) })
    log(`feed url set: ${url} (preferChina=${preferChina}${channel ? `, channel=${channel}` : ''})`)
  } catch (err) {
    log(`feed url set failed: ${(err as Error)?.message || String(err)}`)
  }
}

// Called from the check/download IPC with the renderer's current UI language.
export function setUpdateLanguage(lang: string | undefined): void {
  const china = (lang || '').toLowerCase().startsWith('zh')
  if (china !== preferChina) {
    preferChina = china
    if (app.isPackaged) applyFeedUrl()
  }
}

// Replace the extra feed query (see feedQuery). Invalid keys and non-string
// values are dropped; an empty or invalid input clears it.
export function setUpdateFeedQuery(params: unknown): void {
  const next: Record<string, string> = {}
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (Object.keys(next).length >= FEED_QUERY_MAX_ENTRIES) break
      if (!FEED_QUERY_KEY.test(k) || typeof v !== 'string') continue
      const value = v.trim()
      if (value && value.length <= FEED_QUERY_MAX_VALUE) next[k] = value
    }
  }
  if (JSON.stringify(next) === JSON.stringify(feedQuery)) return
  feedQuery = next
  if (app.isPackaged) applyFeedUrl()
}

// Persist update logs to a file so a user hitting a silent "spinner never
// resolves" can just send us userData/logs/updater.log. We can't rely on a
// logging dep, so this is a tiny append-only writer, plus console for the
// in-app log view / terminal.
let logFile: string | null = null

function initLogFile() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    logFile = path.join(dir, 'updater.log')
  } catch {
    logFile = null
  }
}

function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] [updater] ${parts
    .map((p) => (typeof p === 'string' ? p : safeStringify(p)))
    .join(' ')}`
  // Console: shows up in the terminal (dev) and the packaged app's stdout.
  console.log(line)
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n')
    } catch {
      // ignore disk errors — logging must never break the updater
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function send(status: UpdateStatus) {
  getWindow()?.webContents.send('update-status', status)
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  initLogFile()

  log(`init: appVersion=${app.getVersion()} packaged=${app.isPackaged} logFile=${logFile ?? '<none>'}`)
  if (CONFIGURED_FEEDS.length) {
    activeFeed = loadFeedIndex()
    log(`feeds: ${CONFIGURED_FEEDS.join(' -> ')} (starting at #${activeFeed + 1})`)
  }

  if (UPDATES_DISABLED) {
    // Explicitly opted out (see UPDATES_DISABLED): never wire the updater, so
    // this build can't be pulled onto another product's feed.
    log('updates disabled by app-config (updateFeedUrl=off) — updater wiring skipped')
    return
  }

  // In dev (not packaged) there's no update feed; skip wiring entirely so
  // electron-updater doesn't throw on the missing app-update.yml.
  if (!app.isPackaged) {
    log('not packaged — updater wiring skipped')
    return
  }

  // User-driven flow: we surface "available" and let the user opt in to the
  // download, rather than pulling bytes silently in the background.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // The desktop channel ships pre-release-tagged builds (e.g. 0.0.8-test), so a
  // current version like 0.0.7-test must be allowed to compare against, and be
  // offered, other pre-release versions. Without this electron-updater's semver
  // compare can silently skip pre-releases and neither "available" nor
  // "not-available" fires — the UI just spins forever.
  autoUpdater.allowPrerelease = true
  autoUpdater.allowDowngrade = false
  // Point at the preferred origin up front (defaults to R2; switched to the CN
  // mirror once the renderer reports a zh UI language via setUpdateLanguage).
  applyFeedUrl()
  // Route electron-updater's own internal logging to our file too, so we
  // capture the feed URL, parsed versions and any stack traces it logs.
  autoUpdater.logger = {
    info: (m: unknown) => log('eu-info:', m),
    warn: (m: unknown) => log('eu-warn:', m),
    error: (m: unknown) => log('eu-error:', m),
    debug: (m: unknown) => log('eu-debug:', m),
  } as unknown as typeof autoUpdater.logger

  autoUpdater.on('checking-for-update', () => {
    log(`checking-for-update: current=${app.getVersion()} feed=${feedLabel()}`)
    send({ state: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    log(`update-available: current=${app.getVersion()} remote=${info.version} userInitiated=${userInitiatedCheck} -> update needed`)
    // This feed answered properly: remember it for the next launch.
    saveFeedIndex()
    send({
      state: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      userInitiated: userInitiatedCheck,
    })
  })
  autoUpdater.on('update-not-available', (info) => {
    log(`update-not-available: current=${app.getVersion()} remote=${info?.version ?? '<unknown>'} -> up to date`)
    // The feed answered (404/mismatch counts as "answered" too), so keep it.
    saveFeedIndex()
    send({ state: 'not-available' })
  })
  autoUpdater.on('download-progress', (p) => {
    log(`download-progress: ${Math.round(p.percent)}% (${p.transferred}/${p.total} bytes, ${Math.round(p.bytesPerSecond / 1024)} KB/s)`)
    send({ state: 'downloading', percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log(`update-downloaded: version=${info.version} -> ready to install`)
    send({ state: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    const message = err == null ? 'unknown' : err.message || String(err)
    log(`error: ${message}`, err instanceof Error && err.stack ? err.stack : '')
    send({ state: 'error', message })
  })
}

// Tracks whether the in-flight check was triggered by an explicit user click.
// Stamped onto the resulting 'available' event so the renderer knows whether to
// auto-open the panel (manual) or stay silent with just the dot (automatic).
let userInitiatedCheck = false

// Silent check shortly after launch. When not packaged there's no update feed,
// but a manual click should still get visible feedback instead of looking dead:
// reply "not-available" so the menu can show "up to date".
//   userInitiated: pass true for an explicit "check for update" click so the
//   panel re-opens even if the version was previously dismissed. The startup +
//   interval polls pass false, so a dismissed version only lights the dot.
export function checkForUpdates(userInitiated = false): void {
  userInitiatedCheck = userInitiated
  if (UPDATES_DISABLED) {
    // Manual "check for update" on a build with no feed: answer honestly
    // (up to date) instead of leaving the menu spinning on a dead request.
    log('checkForUpdates: updates disabled by app-config, replying not-available')
    send({ state: 'not-available' })
    return
  }
  if (!app.isPackaged) {
    // Dev-only UI harness: set COW_MOCK_UPDATE=1 to simulate an available
    // update so the update panel/menu interactions can be exercised in
    // `npm run dev` (where there's no real feed). Never runs in a packaged app.
    if (process.env.COW_MOCK_UPDATE) {
      const version = process.env.COW_MOCK_UPDATE_VERSION || '9.9.9'
      log(`checkForUpdates: not packaged, MOCK available version=${version}`)
      send({ state: 'available', version, userInitiated: userInitiatedCheck })
      return
    }
    log('checkForUpdates: not packaged, replying not-available')
    send({ state: 'not-available' })
    return
  }
  candidatesTried = 0
  requestCheck()
}

// One check on the current feed. A failure walks the failover list (see
// switchFeed) before it is reported, so a dead GitHub mirror doesn't stop the
// update.
function requestCheck(): void {
  log(`checkForUpdates: requesting ${feedLabel()}, current=${app.getVersion()}`)
  autoUpdater.checkForUpdates().catch((err) => {
    const message = err?.message || String(err)
    log(`checkForUpdates: failed on ${feedLabel()}: ${message}`, err instanceof Error && err.stack ? err.stack : '')
    if (switchFeed()) {
      log(`checkForUpdates: retrying on ${feedLabel()}`)
      requestCheck()
      return
    }
    log('checkForUpdates: no candidate feed left')
    send({ state: 'error', message })
  })
}

export function startDownload(): void {
  if (!app.isPackaged) return
  candidatesTried = 0
  log(`startDownload: user requested download (feed=${feedLabel()})`)
  attemptDownload()
}

// Download from the current feed; on failure switch to the next candidate (next
// mirror in the configured list, or the other origin for the default feed) and
// try again, until the candidates run out.
function attemptDownload(): void {
  autoUpdater.downloadUpdate().catch((err) => {
    const message = err?.message || String(err)
    log(`startDownload: failed on ${feedLabel()}: ${message}`, err instanceof Error && err.stack ? err.stack : '')
    if (!switchFeed()) {
      log('startDownload: no candidate feed left')
      send({ state: 'error', message })
      return
    }
    log(`startDownload: retrying on ${feedLabel()}`)
    // Re-check first so electron-updater re-reads the feed from the new origin
    // before downloading (its cached updateInfo is origin-agnostic here, but a
    // fresh check keeps the internal state consistent).
    autoUpdater
      .checkForUpdates()
      .then(() => attemptDownload())
      .catch((err2) => {
        const m2 = err2?.message || String(err2)
        log(`startDownload: check on ${feedLabel()} failed: ${m2}`, err2 instanceof Error && err2.stack ? err2.stack : '')
        send({ state: 'error', message: m2 })
      })
  })
}

export function quitAndInstall(): void {
  if (!app.isPackaged) return
  log('quitAndInstall: relaunching to install update')
  // Drop window-all-closed handlers first: a lingering handler can keep the
  // process alive and stop the installer from replacing files / relaunching
  // (a documented electron-updater gotcha, esp. on Windows NSIS).
  app.removeAllListeners('window-all-closed')
  // isSilent=TRUE on Windows. Our installer is now ASSISTED (nsis.oneClick=false
  // + allowToChangeInstallationDirectory) so the FIRST install shows the
  // directory/mode wizard. But an UPDATE must NOT re-show that wizard — isSilent
  // skips it and updates in place. isForceRunAfter=true relaunches after the
  // silent update. (The old assisted+silent force-run bug, #2179, was fixed
  // upstream in PR #2278; we're on electron-updater 6.8.9, well past it.)
  // setImmediate + removeAllListeners are the documented prerequisites for the
  // relaunch to fire reliably. macOS ignores isSilent entirely.
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
}
