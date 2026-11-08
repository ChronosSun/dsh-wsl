// Keep the diff card's Host-facing paths intact, but never show a Windows UNC
// string in a WSL session's labels. The summary's `path` and `cwd` are used by
// `/api/changes.open` to resolve the file on the Host, so only `display` is
// translated; relative display paths are already Linux-neutral.
import { linuxPathFromUnc } from './preset-default.mjs'

export const WSL_PRESET = 'wsl'
const PATCH = Symbol.for('dsh-wsl/changes-paths')

/** `/home/...` for an absolute WSL UNC display path; otherwise the input. */
export function mapDisplayPath(value) {
  const linux = linuxPathFromUnc(value)
  return linux ?? value
}

function unwrap(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
  try { return value[Symbol.for('cordis.original')] ?? value } catch { return value }
}

/**
 * Install the display-path translation on the Host `workspaceChanges` service.
 * Only summaries/diffs owned by a WSL-preset Session are touched.
 *
 * @returns `{ installed, dispose }`; `installed` is a live getter.
 */
export function installWorkspaceChangesPaths(ctx) {
  const disposers = []
  let installed = false

  const presetOfSession = (sessionId) => {
    try {
      const agent = ctx.get('agents')?.get?.(sessionId)
      return ctx.get('agentPresets')?.presetForSession?.(agent?.session)
    } catch {
      return undefined
    }
  }

  const install = (service) => {
    if (installed) return true
    const raw = unwrap(service)
    if (!raw || typeof raw.summary !== 'function' || typeof raw.diff !== 'function') return false
    if (raw[PATCH]) { installed = true; return true }

    const originalSummary = raw.summary
    const originalDiff = raw.diff
    const summaryDescriptor = Object.getOwnPropertyDescriptor(raw, 'summary')
    const diffDescriptor = Object.getOwnPropertyDescriptor(raw, 'diff')
    const summary = function summaryPatched(sessionId, seq) {
      const value = originalSummary.call(raw, sessionId, seq)
      if (!value || presetOfSession(sessionId) !== WSL_PRESET || !Array.isArray(value.files)) return value
      return {
        ...value,
        files: value.files.map((file) => ({ ...file, display: mapDisplayPath(file.display) })),
      }
    }
    const diff = async function diffPatched(sessionId, seq, index, signal) {
      const value = await originalDiff.call(raw, sessionId, seq, index, signal)
      if (!value || presetOfSession(sessionId) !== WSL_PRESET) return value
      return { ...value, display: mapDisplayPath(value.display) }
    }

    try {
      Object.defineProperty(raw, 'summary', { configurable: true, enumerable: false, writable: true, value: summary })
      Object.defineProperty(raw, 'diff', { configurable: true, enumerable: false, writable: true, value: diff })
    } catch {
      return false
    }
    const dispose = () => {
      try { if (summaryDescriptor) Object.defineProperty(raw, 'summary', summaryDescriptor) } catch {}
      try { if (diffDescriptor) Object.defineProperty(raw, 'diff', diffDescriptor) } catch {}
      try { delete raw[PATCH] } catch {}
    }
    Object.defineProperty(raw, PATCH, { configurable: true, enumerable: false, writable: true, value: dispose })
    disposers.push(dispose)
    installed = true
    return true
  }

  const current = ctx.get('workspaceChanges')
  if (current) install(current)
  else ctx.on('internal/service', (name, value) => { if (name === 'workspaceChanges') install(value) })

  return {
    get installed() { return installed },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
      installed = false
    },
  }
}
