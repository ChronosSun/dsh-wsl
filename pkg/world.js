// The WSL execution world: one preset-scoped `ctx.subprocess` for Linux.
//
// NOTE: no `#private` members here on purpose. Cordis wraps a Service instance
// in a context proxy, so methods can run with a `this` that is not the branded
// original; V8 then throws "Receiver must be an instance of class ...". Plain
// underscore properties survive that indirection.
//
// It also does not hard-depend on `@deepseek-ai/dsh-subprocess`: a
// profile-installed plugin cannot resolve the harness' own packages (verified:
// ERR_MODULE_NOT_FOUND from the profile), so the Service base is imported when
// available and otherwise replaced by a shim that registers through Context.
import { appendFileSync } from 'node:fs'
import { registry } from './src/registry.mjs'
import { parseWslUnc } from './src/broker.mjs'
import { createWslSubprocess } from './src/subprocess.mjs'
import { defaultDistro, userFor } from './src/settings.mjs'
import { userFromLinuxPath } from './src/path-user.mjs'

const LOG = 'C:\\Users\\Yunson\\dsh-wsl-plugin\\wsl-world.log'
const DEBUG = process.env.DSH_WSL_DEBUG === '1'
function log(line) {
  if (DEBUG) try { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`) } catch {}
}

let Base = null
let baseError = ''
try {
  const mod = await import('@deepseek-ai/dsh-subprocess')
  Base = mod.SubprocessRuntime ?? mod.default ?? null
} catch (error) {
  baseError = String(error?.code ?? error?.message ?? error)
  Base = null
}
log(`import base=${Base ? 'real' : 'shim'}${baseError ? ` (${baseError})` : ''}`)

class ServiceShim {
  constructor(ctx) {
    this.ctx = ctx
    if (typeof ctx.set !== 'function') {
      throw new Error('subprocess-wsl: this Harness build exposes neither the Service base class nor ctx.set')
    }
    ctx.provide?.('subprocess')
    ctx.set('subprocess', this)
    log('shim installed ctx.subprocess')
  }
}

const Parent = Base ?? ServiceShim

export default class WslSubprocessWorld extends Parent {
  _impls = new Map()
  _config = {}

  constructor(ctx, config = {}) {
    super(ctx)
    if (!this.ctx) this.ctx = ctx
    this._config = config ?? {}
    log(`ctor ok base=${Base ? 'real' : 'shim'} distro=${this._config.distro ?? ''}`)
  }

  /** One implementation per (distro, user); sessions in different distros coexist. */
  _for(cwd) {
    const parsed = parseWslUnc(cwd)
    const distro = parsed?.distro ?? (this._config.distro || defaultDistro())
    // The workspace path wins: /home/alice means alice, /root means root.
    const linux = parsed?.linuxPath ?? (typeof cwd === 'string' && cwd.startsWith('/') ? cwd : '')
    const user = this._config.user || userFromLinuxPath(linux) || userFor(distro)
    const key = `${distro}|${user}`
    if (!this._impls) this._impls = new Map()
    let impl = this._impls.get(key)
    if (!impl) {
      // Shared with the panel, so its connection state is the session's state.
      const broker = registry.get(distro, user)
      // Resolve the login PATH (minus /mnt) before the first command: the
      // spawn path is synchronous, so it falls back until this connect lands.
      broker.connect().catch(() => {})
      impl = createWslSubprocess({ broker, distro, user })
      this._impls.set(key, impl)
      log(`impl created for ${key}`)
    }
    return impl
  }

  resolveExecutable(command, env, signal) {
    log(`resolveExecutable ${command}`)
    return this._for(undefined).resolveExecutable(command, env, signal)
  }

  terminalEnvironment(signal) {
    return this._for(undefined).terminalEnvironment(signal)
  }

  spawn(spec) {
    log(`spawn cwd=${spec?.cwd} argv=${JSON.stringify(spec?.argv)}`)
    return this._for(spec?.cwd).spawn(spec)
  }

  async spawnTerminal(spec, delegate) {
    // Delegate to the host PTY: wsl.exe allocates the tty, Linux bash inherits
    // it. `root` is outside this isolate realm, so it is the local provider.
    const host = delegate ?? this.ctx?.root?.get?.('subprocess')
    if (!host || host === this) {
      throw Object.assign(new Error('subprocess-wsl: host PTY provider unavailable'), { code: 'SUBPROCESS_UNSUPPORTED' })
    }
    return this._for(spec?.cwd).spawnTerminal(spec, host)
  }

  async dispose() {
    for (const impl of this._impls?.values() ?? []) await impl.dispose?.().catch(() => {})
    this._impls?.clear()
  }
}
