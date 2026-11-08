// Hide the internal WSL execution variants from the Agent-preset roster.
//
// WSL is a workspace execution world, not a user-selectable mode. The panel
// still needs `wsl-standard` / `wsl-cordis` to exist so a WSL session can keep
// the tool set of the selected global mode, but the roster should show only
// Standard and Creator.
const HIDDEN = new Set(['wsl', 'wsl-standard', 'wsl-cordis'])
const ORIGINAL = Symbol.for('cordis.original')
const PATCHED = Symbol.for('dsh-wsl/preset-roster-filter')

function unwrap(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
  try {
    return value[ORIGINAL] ?? value
  } catch {
    return value
  }
}

function keep(row) {
  return !HIDDEN.has(row?.id)
}

export function installPresetRosterFilter(ctx) {
  let installed = false
  const disposers = []

  const install = (service) => {
    if (installed) return true
    const raw = unwrap(service)
    if (!raw || typeof raw !== 'object') return false
    if (raw[PATCHED]) {
      installed = true
      return true
    }

    const originalRemote = raw.remoteExportList
    const originalList = raw.list
    if (typeof originalRemote !== 'function' && typeof originalList !== 'function') return false

    if (typeof originalList === 'function') {
      raw.list = async function list(...args) {
        const rows = await originalList.apply(raw, args)
        return Array.isArray(rows) ? rows.filter(keep) : rows
      }
    }
    if (typeof originalRemote === 'function') {
      raw.remoteExportList = async function remoteExportList(...args) {
        const roster = await originalRemote.apply(raw, args)
        if (!roster || !Array.isArray(roster.presets)) return roster
        return { ...roster, presets: roster.presets.filter(keep) }
      }
    }

    const dispose = () => {
      try { delete raw.list } catch {}
      try { delete raw.remoteExportList } catch {}
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

  let current
  try { current = ctx.get('agentPresets') } catch {}
  if (current) install(current)
  else ctx.on('internal/service', (name, value) => {
    if (name === 'agentPresets') install(value)
  })

  return {
    get installed() { return installed },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
      installed = false
    },
  }
}
