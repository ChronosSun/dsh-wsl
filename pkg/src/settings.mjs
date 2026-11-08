// Small user settings store for the panel/doctor: per-distro login user and a
// default distro. Deliberately separate from the profile patch (the user owns
// that file); the plugin only reads/writes its own JSON under ~/.dsh.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const settingsFile = join(homedir(), '.dsh', 'remote-wsl-settings.json')

function normalize(raw) {
  const idle = Number(raw?.idleDays)
  return {
    users: { ...(raw && typeof raw.users === 'object' && raw.users !== null ? raw.users : {}) },
    defaultDistro: typeof raw?.defaultDistro === 'string' ? raw.defaultDistro : '',
    idleDays: Number.isFinite(idle) && idle >= 0 ? idle : 5,
  }
}

export function readSettings() {
  try {
    return normalize(JSON.parse(readFileSync(settingsFile, 'utf8')))
  } catch {
    return normalize({})
  }
}

export function writeSettings(patch = {}) {
  const current = readSettings()
  const next = normalize({
    ...current,
    ...patch,
    users: { ...current.users, ...(patch.users ?? {}) },
  })
  try {
    mkdirSync(dirname(settingsFile), { recursive: true })
    const tmp = `${settingsFile}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, settingsFile)
  } catch {}
  return next
}

/** Per-distro login user; empty means the distribution default. */
export function userFor(distro) {
  const settings = readSettings()
  return settings.users[distro ?? ''] ?? settings.users[''] ?? ''
}

export function defaultDistro() {
  return readSettings().defaultDistro
}
