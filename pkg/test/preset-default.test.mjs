// Offline checks for the WSL-workspace session preset default.
// Run: node test/preset-default.test.mjs
import {
  isWslPath,
  installModelCwdTranslation,
  installSessionPresetDefault,
  linuxPathFromUnc,
  presetForRequest,
  workspacePathOf,
  WSL_PRESET,
  WSL_STANDARD_PRESET,
  WSL_CORDIS_PRESET,
  WSL_PTC_PRESET,
  WSL_MINIMAL_PRESET,
} from '../src/preset-default.mjs'

let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

// --- path recognition -------------------------------------------------------
const yes = [
  '\\\\wsl.localhost\\Ubuntu-24.04\\home\\chronos',
  '\\\\wsl$\\Ubuntu-22.04\\srv',
  '//wsl.localhost/Ubuntu-24.04/home',
  '\\\\?\\UNC\\wsl.localhost\\Ubuntu-24.04\\home',
]
const no = ['', 'C:\\Users\\Yunson', '\\\\server\\share\\dir', '/home/chronos', '\\\\wsl.localhost', '\\\\wsl.foo\\x']
for (const path of yes) check(`isWslPath(${JSON.stringify(path)})`, isWslPath(path), true)
for (const path of no) check(`isWslPath(${JSON.stringify(path)})`, isWslPath(path), false)

// --- UNC -> Linux translation ----------------------------------------------
check('linux from localhost UNC', linuxPathFromUnc('\\\\wsl.localhost\\Ubuntu-24.04\\home\\chronos'), '/home/chronos')
check('linux from wsl$ UNC', linuxPathFromUnc('\\\\wsl$\\Ubuntu-22.04\\srv'), '/srv')
check('linux from forward-slash UNC', linuxPathFromUnc('//wsl.localhost/Ubuntu-24.04/home'), '/home')
check('linux from extended UNC', linuxPathFromUnc('\\\\?\\UNC\\wsl.localhost\\Ubuntu-24.04\\home'), '/home')
check('linux from distro root', linuxPathFromUnc('\\\\wsl.localhost\\Ubuntu-24.04'), '/')
check('linux from Windows path', linuxPathFromUnc('C:\\Users\\Yunson'), undefined)
check('linux from Linux path', linuxPathFromUnc('/home/chronos'), undefined)

// --- pure decision ----------------------------------------------------------
const registry = {
  get: (id) => ({
    wsl: { path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\chronos' },
    win: { path: 'C:\\Users\\Yunson\\project' },
  })[id],
}
const fakeCtx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
check('WSL workspace', presetForRequest(fakeCtx, { workspaceId: 'wsl' }), WSL_STANDARD_PRESET)
check('Windows workspace', presetForRequest(fakeCtx, { workspaceId: 'win' }), undefined)
check('explicit standard maps to WSL standard', presetForRequest(fakeCtx, { workspaceId: 'wsl', agentPreset: 'standard' }), WSL_STANDARD_PRESET)
check('explicit creator maps to WSL creator', presetForRequest(fakeCtx, { workspaceId: 'wsl', agentPreset: 'cordis' }), WSL_CORDIS_PRESET)
check('explicit PTC maps to WSL PTC', presetForRequest(fakeCtx, { workspaceId: 'wsl', agentPreset: 'ptc' }), WSL_PTC_PRESET)
check('explicit minimal maps to WSL minimal', presetForRequest(fakeCtx, { workspaceId: 'wsl', agentPreset: 'minimal' }), WSL_MINIMAL_PRESET)
check('UNC cwd without workspace', presetForRequest(fakeCtx, { cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\srv\\app' }), WSL_STANDARD_PRESET)
check('no location', presetForRequest(fakeCtx, {}), undefined)
check('unknown workspace', workspacePathOf(registry, 'nope'), '')

// --- installation over a Cordis-style proxy --------------------------------
class FakeController {
  constructor() { this.requests = [] }
  async create(request) { this.requests.push(request); return { sessionId: 'session', agentPreset: request.agentPreset } }
}

function traceable(target) {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === Symbol.for('cordis.original')) return t
      return Reflect.get(t, prop, receiver)
    },
  })
}

function makeHost({ controller, presetFails = false } = {}) {
  const listeners = {}
  const services = {
    workspaceRegistry: registry,
    agentPresets: {
      resolve: async (id) => {
        if (presetFails) throw new Error('agent-preset/not-found')
        return { id }
      },
    },
  }
  if (controller) services.sessionController = traceable(controller)
  const ctx = {
    get: (name) => services[name],
    on: (name, fn) => { listeners[name] = fn },
  }
  return { ctx, listeners }
}

{
  const controller = new FakeController()
  const { ctx } = makeHost({ controller })
  const patch = installSessionPresetDefault(ctx)
  check('patch installs immediately', patch.installed, true)

  await controller.create({ workspaceId: 'wsl' })
  await controller.create({ workspaceId: 'win' })
  await controller.create({ workspaceId: 'wsl', agentPreset: 'standard' })
  await controller.create({ cwd: '\\\\wsl$\\Ubuntu-24.04\\srv' })

  check('WSL request gains the variant', controller.requests[0].agentPreset, WSL_STANDARD_PRESET)
  check('Windows request stays default', controller.requests[1].agentPreset, undefined)
  check('explicit standard is mapped', controller.requests[2].agentPreset, WSL_STANDARD_PRESET)
  check('UNC cwd gains the variant', controller.requests[3].agentPreset, WSL_STANDARD_PRESET)

  patch.dispose()
  await controller.create({ workspaceId: 'wsl' })
  check('dispose restores the original', controller.requests[4].agentPreset, undefined)
  check('dispose clears installed', patch.installed, false)
}

{
  const { ctx, listeners } = makeHost({})
  const patch = installSessionPresetDefault(ctx)
  check('waits for a late service', patch.installed, false)
  const late = new FakeController()
  listeners['internal/service']('sessionController', traceable(late))
  await late.create({ workspaceId: 'wsl' })
  check('late service is patched', late.requests[0].agentPreset, WSL_STANDARD_PRESET)
  check('late install flips installed', patch.installed, true)
  patch.dispose()
}

{
  const controller = new FakeController()
  const { ctx } = makeHost({ controller, presetFails: true })
  installSessionPresetDefault(ctx)
  await controller.create({ workspaceId: 'wsl' })
  check('missing WSL preset falls back to Host default', controller.requests[0].agentPreset, undefined)
}

// --- model-facing cwd translation ------------------------------------------
class FakeWorkingDirectory {
  constructor(sessions) { this.sessions = sessions }
  get(session) { return this.sessions[session] }
  contextText(session) { return `Current working directory: ${JSON.stringify(this.get(session))}.` }
}

{
  const wd = new FakeWorkingDirectory({
    'session-wsl': '\\\\wsl.localhost\\Ubuntu-24.04\\home\\chronos\\develop',
    'session-ptc': '\\\\wsl.localhost\\Ubuntu-24.04\\home\\chronos\\develop',
    'session-linux': '/home/chronos/develop',
  })
  const presets = { presetForSession: (session) => session === 'session-ptc' ? 'ptc' : session === 'session-linux' ? WSL_CORDIS_PRESET : WSL_PRESET }
  const ctx = {
    get: (name) => name === 'workingDirectory' ? wd : name === 'agentPresets' ? presets : undefined,
    on: () => {},
  }
  const uncText = wd.contextText('session-wsl')
  const patch = installModelCwdTranslation(ctx)
  check('cwd translation installs', patch.installed, true)
  check('WSL session shows Linux cwd', wd.contextText('session-wsl'), 'Current working directory: "/home/chronos/develop".')
  check('non-WSL session keeps UNC', wd.contextText('session-ptc'), uncText)
  check('Linux cwd left alone', wd.contextText('session-linux'), 'Current working directory: "/home/chronos/develop".')
  patch.dispose()
  check('cwd translation restores', wd.contextText('session-wsl'), uncText)
}

{
  const listeners = {}
  const wd = new FakeWorkingDirectory({ s: '\\\\wsl.localhost\\Ubuntu\\home\\u' })
  const ctx = {
    get: (name) => name === 'workingDirectory' ? undefined : name === 'agentPresets' ? { presetForSession: () => 'wsl' } : undefined,
    on: (name, fn) => { listeners[name] = fn },
  }
  const patch = installModelCwdTranslation(ctx)
  check('cwd translation waits for the service', patch.installed, false)
  listeners['internal/service']('workingDirectory', wd)
  check('late workingDirectory is patched', wd.contextText('s'), 'Current working directory: "/home/u".')
  patch.dispose()
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
