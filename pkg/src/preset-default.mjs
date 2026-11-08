// Host-side default Agent preset for WSL workspaces.
//
// The Workspace UI's New Session path never names a preset (`startSession` /
// `openWorkspace` / `connectWorkspace` all omit it), so every session created
// in a `\\wsl.localhost\...` workspace used to fall back to the Host default
// (`ptc`/`standard`) and silently ran its tools on Windows. This patch rewrites
// the one request every Client creation path funnels through:
// `sessionController.create`.
//
// Cordis exposes a Service through a tracing Proxy; the original instance is
// reachable through the global `cordis.original` symbol. Patching the instance
// (not the Proxy) is what the Typert gateway resolves for each call, so it
// applies to every Client and every UI entry point, including a browser that
// was loaded before this plugin. An explicit `agentPreset` always wins.
//
// The patch is deliberately scoped by path: a Windows Workspace keeps the Host
// default. `agentPresets.resolve('wsl')` is checked once per process so a
// profile where the preset row failed to activate falls back instead of making
// every session creation fail.

export const WSL_PRESET = 'wsl'

const ORIGINAL = Symbol.for('cordis.original')
const PATCHED = Symbol.for('dsh-wsl/preset-default')
const CWD_PATCHED = Symbol.for('dsh-wsl/model-cwd')

// `\\wsl.localhost\<distro>\...`, `//wsl.localhost/...`, `\\wsl$\...`.
const WSL_UNC = /^[\\/]{2}\??(?:wsl\.localhost|wsl\$)[\\/]/i
// Extended-length form: `\\?\UNC\wsl.localhost\...`.
const WSL_EXTENDED_UNC = /^\\\\\?\\UNC\\(?:wsl\.localhost|wsl\$)[\\/]/i

/** True for a Windows UNC path that addresses a WSL distribution. */
export function isWslPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  return WSL_UNC.test(value) || WSL_EXTENDED_UNC.test(value)
}

/**
 * Translate a WSL UNC path to the Linux path the tools actually use.
 * `\\\\wsl.localhost\\Ubuntu\\home\\me` -> `/home/me`; anything else -> undefined.
 */
export function linuxPathFromUnc(value) {
  const raw = String(value ?? '')
  if (raw.length === 0) return undefined
  const extended = /^\\\\\?\\UNC\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/i.exec(raw)
  if (extended) return '/' + extended[2].replace(/\\/g, '/')
  const normal = /^[\\/]{2}\??(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(raw)
  if (!normal) return undefined
  return '/' + (normal[2] ?? '').replace(/\\/g, '/')
}

/** Resolve the Workspace path through the Host registry, tolerating absence. */
export function workspacePathOf(workspaceRegistry, workspaceId) {
  if (workspaceId === undefined || workspaceId === null || workspaceId === '') return ''
  try {
    const workspace = workspaceRegistry?.get?.(workspaceId)
    return typeof workspace?.path === 'string' ? workspace.path : ''
  } catch {
    return ''
  }
}

/** The preset a create request should use, or undefined to leave it to the Host. */
export function presetForRequest(ctx, request) {
  if (!request || typeof request !== 'object') return undefined
  if (request.agentPreset !== undefined) return undefined
  const cwd = typeof request.cwd === 'string' ? request.cwd : ''
  if (cwd !== '') return isWslPath(cwd) ? WSL_PRESET : undefined
  let registry
  try {
    registry = ctx.get('workspaceRegistry')
  } catch {
    return undefined
  }
  return isWslPath(workspacePathOf(registry, request.workspaceId)) ? WSL_PRESET : undefined
}

function unwrap(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
  try {
    return value[ORIGINAL] ?? value
  } catch {
    return value
  }
}

/**
 * Install the request-rewriting patch on the Host `sessionController`.
 *
 * The service may not exist yet when the plugin applies; the `internal/service`
 * event covers that without making the whole plugin row depend on it.
 *
 * @returns `{ installed, dispose }`; `installed` is a live getter.
 */
export function installSessionPresetDefault(ctx) {
  const disposers = []
  let installed = false
  let wslPresetReady = false
  let checking = null

  async function presetAvailable() {
    if (wslPresetReady) return true
    if (checking === null) {
      checking = (async () => {
        let presets
        try {
          presets = ctx.get('agentPresets')
        } catch {
          return false
        }
        if (typeof presets?.resolve !== 'function') return false
        try {
          await presets.resolve(WSL_PRESET)
          return true
        } catch {
          return false
        }
      })().finally(() => { checking = null })
    }
    const ok = await checking
    // A failed probe may mean the preset row is still mounting, so only the
    // positive answer is cached for the life of the process.
    if (ok) wslPresetReady = true
    return ok
  }

  const install = (service) => {
    if (installed) return true
    const raw = unwrap(service)
    if (!raw || typeof raw.create !== 'function') return false
    if (raw[PATCHED]) {
      installed = true
      return true
    }

    const original = raw.create
    const patched = async function create(request) {
      const preset = presetForRequest(ctx, request)
      const next = preset === undefined || !(await presetAvailable())
        ? request
        : { ...request, agentPreset: preset }
      return original.call(raw, next)
    }

    try {
      Object.defineProperty(raw, 'create', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: patched,
      })
    } catch {
      return false
    }

    const dispose = () => {
      try { delete raw.create } catch {}
      try { delete raw[PATCHED] } catch {}
    }
    Object.defineProperty(raw, PATCHED, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: dispose,
    })
    disposers.push(dispose)
    installed = true
    return true
  }

  const current = ctx.get('sessionController')
  if (current) install(current)
  else ctx.on('internal/service', (name, value) => {
    if (name === 'sessionController') install(value)
  })

  return {
    get installed() { return installed },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
      installed = false
    },
  }
}

/**
 * Present a Linux working directory to the model in WSL-preset sessions.
 *
 * The session's durable `cwd` stays the UNC path on purpose: Host features
 * (diff view, `@` references, open-in-app, workspace grouping) resolve it
 * through the Windows filesystem. But the Agent's tools all run in WSL and
 * every path it writes is Linux, so showing `\\\\wsl.localhost\\...` as its
 * `Current working directory` is the one remaining Windows-shaped input that
 * makes the model emit Windows paths.
 *
 * Patch only `WorkingDirectoryService.contextText`, the model-facing string:
 * `get`/`set`/the durable projection keep the UNC value, so no Host feature
 * breaks. Only sessions whose recorded preset is `wsl` are rewritten.
 *
 * @returns `{ installed, dispose }`; `installed` is a live getter.
 */
export function installModelCwdTranslation(ctx) {
  const disposers = []
  let installed = false
  let presetsService

  const presetOf = (session) => {
    try {
      presetsService ??= ctx.get('agentPresets')
      return presetsService?.presetForSession?.(session)
    } catch {
      return undefined
    }
  }

  const install = (service) => {
    if (installed) return true
    const raw = unwrap(service)
    if (!raw || typeof raw.contextText !== 'function' || typeof raw.get !== 'function') return false
    if (raw[CWD_PATCHED]) {
      installed = true
      return true
    }

    const original = raw.contextText
    const patched = function contextText(session) {
      const text = original.call(raw, session)
      try {
        if (presetOf(session) !== WSL_PRESET) return text
        const linux = linuxPathFromUnc(raw.get(session))
        if (linux === undefined) return text
        return `Current working directory: ${JSON.stringify(linux)}.`
      } catch {
        return text
      }
    }

    try {
      Object.defineProperty(raw, 'contextText', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: patched,
      })
    } catch {
      return false
    }

    const dispose = () => {
      try { delete raw.contextText } catch {}
      try { delete raw[CWD_PATCHED] } catch {}
    }
    Object.defineProperty(raw, CWD_PATCHED, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: dispose,
    })
    disposers.push(dispose)
    installed = true
    return true
  }

  const current = ctx.get('workingDirectory')
  if (current) install(current)
  else ctx.on('internal/service', (name, value) => {
    if (name === 'workingDirectory') install(value)
  })

  return {
    get installed() { return installed },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
      installed = false
    },
  }
}
