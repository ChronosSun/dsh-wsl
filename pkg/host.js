// Host half: the WSL panel's data routes.
// Each endpoint is an exact route: prefix matching was measured to not cover
// sub-paths here, and exact routes are unambiguous. Handler routes (not
// resources) are used because resources answer GET/HEAD only.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { registry } from './src/registry.mjs'
import { installModelCwdTranslation, installSessionPresetDefault, WSL_PRESET } from './src/preset-default.mjs'
import { installWslFileReferences } from './src/file-references.mjs'
import { installWorkspaceChangesPaths } from './src/changes-paths.mjs'
import { installWslDiff } from './src/wsl-diff-v2.mjs'
import { readSettings, userFor, writeSettings } from './src/settings.mjs'
import { runDoctor, runFix, detectUsers, listWslDistros } from './src/doctor.mjs'

const BASE = '/dsh-wsl'
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '' } catch { return '' }
})()

// A live profile reconcile starts the new row before the previous incarnation
// is always gone; its exact routes then still sit in webServer. Reinstalling
// during development must not fail with `duplicate exact route` and must not
// leave the panel on the old handler, so take the route over when the exact
// path is already owned. Our disposer removes the path only while it still
// holds this route, so a later reload cannot delete a successor's handler.
const ORIGINAL = Symbol.for('cordis.original')

function registerExactRoute(webServer, route) {
  try {
    return webServer.register(route)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!message.includes('duplicate')) throw error
    const raw = webServer?.[ORIGINAL] ?? webServer
    const table = raw?.exact
    if (!(table instanceof Map)) throw error
    table.set(route.path, route)
    console.warn(`[dsh-wsl] took over ${route.path} from a previous plugin instance`)
    return () => { if (table.get(route.path) === route) table.delete(route.path) }
  }
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk; if (data.length > 1 << 20) req.destroy() })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function listDistros() {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-l', '-q'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString('utf16le')))
    child.on('error', () => resolve([]))
    child.on('close', () => {
      const names = out
        .replace(/\0/g, '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      resolve([...new Set(names)])
    })
  })
}

export const name = 'dsh-wsl'
export const inject = ['webServer']

// Must be an arrow function: Cordis treats a `function` declaration as a
// constructible class (`new apply(ctx)`), and then discards the cleanup this
// function returns. Without that cleanup the exact routes survive a reload and
// every reinstall fails with `duplicate exact route`.
export const apply = (ctx) => {
  const webServer = ctx.webServer
  if (!webServer) return

  // Every New Session / Workspace-open request in a WSL workspace omits the
  // preset; without this patch those sessions run on Windows. Installed before
  // the routes so `/state` can report whether the seam is live.
  const presetDefault = installSessionPresetDefault(ctx)
  // Keep the durable UNC cwd for Host features, but show the model the Linux
  // directory its tools actually use. No-op for non-WSL sessions.
  const modelCwd = installModelCwdTranslation(ctx)
  // `@file` discovery: WSL Agents index the distribution instead of the UNC
  // share. Diff labels translate absolute UNC display paths to Linux while the
  // underlying Host summary/diff still serves the open/compare coordinates.
  const fileReferences = installWslFileReferences(ctx)
  const changesPaths = installWorkspaceChangesPaths(ctx)
  const wslDiff = installWslDiff(ctx)

  const bootSettings = readSettings()
  registry.idleMinutes = bootSettings.idleDays * 24 * 60

  const hasService = (name) => {
    try { return ctx.get(name) !== undefined } catch { return false }
  }
  const capabilities = () => ({
    webServer: true,
    sessionController: hasService('sessionController'),
    workingDirectory: hasService('workingDirectory'),
    workspaceRegistry: hasService('workspaceRegistry'),
    agentPresets: hasService('agentPresets'),
    fileReferences: hasService('fileReferences'),
    workspaceChanges: hasService('workspaceChanges'),
    agents: hasService('agents'),
  })

  const routes = [
    ['GET', BASE, async (req, res) => send(res, 200, { ok: true, name, version: VERSION })],
    ['GET', `${BASE}/distros`, async (req, res) => send(res, 200, { distros: await listDistros() })],
    ['GET', `${BASE}/state`, async (req, res) => send(res, 200, {
      version: VERSION,
      idleMinutes: registry.idleMinutes,
      idleDays: readSettings().idleDays,
      brokers: registry.list(),
      settings: readSettings(),
      capabilities: capabilities(),
      presetDefault: { installed: presetDefault.installed, preset: WSL_PRESET },
      modelCwd: { installed: modelCwd.installed },
      fileReferences: { installed: fileReferences.installed },
      changesPaths: { installed: changesPaths.installed },
      wslDiff: { installed: wslDiff.installed, stats: wslDiff.stats },
    })],
    ['*', `${BASE}/settings`, async (req, res) => {
      if ((req.method ?? 'GET') === 'GET') return send(res, 200, readSettings())
      const body = await readBody(req)
      send(res, 200, writeSettings(body))
    }],    ['GET', `${BASE}/doctor`, async (req, res) => send(res, 200, await runDoctor(ctx, {
      version: VERSION,
      capabilities: capabilities(),
      flags: {
        presetDefault: presetDefault.installed,
        modelCwd: modelCwd.installed,
        fileReferences: fileReferences.installed,
        changesPaths: changesPaths.installed,
        wslDiff: wslDiff.installed,
      },
    }))],
    ['POST', `${BASE}/doctor/fix`, async (req, res) => {
      const body = await readBody(req)
      send(res, 200, await runFix(body.distro ?? '', body.action ?? '', body.user ?? '', body.name ?? ''))
    }],
    ['GET', `${BASE}/changes`, async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const seq = Number(url.searchParams.get('seq') ?? -1)
      const summary = ctx.get('workspaceChanges')?.summary(sessionId, seq)
      if (summary === undefined) return send(res, 404, { error: 'change summary unavailable' })
      send(res, 200, summary)
    }],
    ['GET', `${BASE}/changes/diff`, async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const seq = Number(url.searchParams.get('seq') ?? -1)
      const index = Number(url.searchParams.get('index') ?? -1)
      const diff = await ctx.get('workspaceChanges')?.diff(sessionId, seq, index, AbortSignal.timeout(30_000))
      if (diff === undefined) return send(res, 404, { error: 'change comparison unavailable' })
      send(res, 200, diff)
    }],
    ['GET', `${BASE}/workspaces`, async (req, res) => {
      // `ctx.get` does not require an inject declaration, unlike `ctx.<name>`;
      // this row only injects webServer and must not fail at request time.
      const list = ctx.get('workspaceRegistry')?.list?.() ?? []
      send(res, 200, {
        workspaces: list.map((w) => ({
          id: w.id ?? w.workspaceId,
          path: w.path ?? w.directory ?? '',
          title: w.title ?? w.name ?? '',
        })),
      })
    }],
    ['GET', `${BASE}/browse`, async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const distro = url.searchParams.get('distro') ?? ''
      const user = url.searchParams.get('user') ?? userFor(distro)
      const wanted = url.searchParams.get('path') ?? ''
      const broker = registry.get(distro, user)
      const hello = await broker.connect().then(() => broker.hello)
      const target = wanted || hello.home
      const listing = await broker.call('list', { path: target })
      const dirs = listing.entries
        .filter((e) => e.dir)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => ({ name: e.name, path: target.replace(/\/$/, '') + '/' + e.name }))
      const parent = target.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'
      send(res, 200, { distro, user, path: target, parent, home: hello.home, dirs })
    }],
    ['POST', `${BASE}/connect`, async (req, res) => {
      const body = await readBody(req)
      const distro = body.distro ?? ''
      const broker = registry.get(distro, body.user ?? userFor(distro))
      await broker.connect()
      send(res, 200, { ok: true, broker: broker.info, hello: broker.hello })
    }],
    ['POST', `${BASE}/disconnect`, async (req, res) => {
      const body = await readBody(req)
      await registry.peek(body.distro ?? '', body.user ?? userFor(body.distro ?? ''))?.disconnect('panel')
      send(res, 200, { ok: true })
    }],
    ['POST', `${BASE}/idle`, async (req, res) => {
      const body = await readBody(req)
      const days = body.days !== undefined ? Number(body.days) : Number(body.minutes) / (24 * 60)
      if (!Number.isFinite(days) || days < 0) return send(res, 400, { error: 'days must be a non-negative number' })
      const saved = writeSettings({ idleDays: days })
      registry.idleMinutes = days * 24 * 60
      send(res, 200, { ok: true, idleDays: saved.idleDays, idleMinutes: registry.idleMinutes })
    }],
  ]

  const disposers = routes.map(([method, path, run]) => registerExactRoute(webServer, {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (method !== '*' && (req.method ?? 'GET') !== method) return send(res, 405, { error: 'method not allowed', method: req.method })
      try {
        await run(req, res)
      } catch (error) {
        send(res, 500, { error: String(error?.message ?? error) })
      }
    },
  }))

  // A distro whose default user is root should not silently run the Agent as
  // root. Detect the first normal user at Host boot and persist it as the
  // default for that distro (no-op when the distro default is already normal).
  const applyDefaultUsers = async () => {
    try {
      const settings = readSettings()
      let changed = false
      for (const distro of await listWslDistros()) {
        if (settings.users[distro]) continue
        const info = await detectUsers(distro)
        if (info.root && info.users.length > 0 && !settings.users[distro]) {
          settings.users[distro] = info.users[0].name
          changed = true
        }
      }
      if (changed) writeSettings({ users: settings.users })
    } catch {}
  }
  void applyDefaultUsers()

  return () => {
    presetDefault.dispose()
    modelCwd.dispose()
    fileReferences.dispose()
    changesPaths.dispose()
    wslDiff.dispose()
    for (const dispose of disposers) dispose()
  }
}

