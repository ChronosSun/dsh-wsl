// WSL-backed `@file` discovery for WSL-preset Agents.
//
// The shipped `file-reference-local` provider walks the Host filesystem at the
// session's UNC cwd (Node fs over 9P) and only knows Windows paths. This patch
// keeps that provider for every other preset and answers WSL Agents from the
// distribution: a bounded `tree` RPC through the broker, ranked exactly like
// the host provider, with paths relative to the Linux cwd. A relative `@path`
// then means the same file to the model and to the Host UI.
import { registry } from './registry.mjs'
import { linuxPathFromUnc } from './preset-default.mjs'
import { userFor } from './settings.mjs'
import { userFromLinuxPath } from './path-user.mjs'

export const WSL_PRESET = 'wsl'
const MAX_RESULTS = 20
const MAX_ENTRIES = 50_000
const CACHE_MS = 5_000
const PATCH = Symbol.for('dsh-wsl/file-references')

const EXCLUDED = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.turbo', '.venv', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.gradle',
])

function visibleForGlobalQuery(path, query) {
  if (query.startsWith('.') || query.includes('/.')) return true
  return !path.split('/').some((segment) => segment.startsWith('.'))
}

function subsequenceScore(target, query) {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

function scoreCandidate(candidate, query) {
  if (query === '') return 0
  const path = candidate.path.toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const needle = query.toLowerCase()
  const directoryBonus = candidate.kind === 'directory' ? 25 : 0
  if (name === needle) return 1_000 + directoryBonus
  if (name.startsWith(needle)) return 900 + directoryBonus
  if (name.includes(needle)) return 700 + directoryBonus
  if (path.includes(needle)) return 500 + directoryBonus
  const subsequence = subsequenceScore(path, needle)
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus
}

function kindRank(kind) { return kind === 'directory' ? 0 : 1 }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0 }

function rankCandidates(candidates, query, limit) {
  const ranked = []
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query)
    if (score !== undefined) ranked.push({ candidate, score })
  }
  ranked.sort((left, right) => right.score - left.score
    || kindRank(left.candidate.kind) - kindRank(right.candidate.kind)
    || (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length)
    || compareText(left.candidate.path, right.candidate.path))
  return ranked.slice(0, limit).map((entry) => entry.candidate)
}

/** Rank bounded tree entries for one `@` token; pure, used by tests. */
export function candidatesFromEntries(entries, rawQuery, limit = MAX_RESULTS) {
  const query = String(rawQuery ?? '').replaceAll('\\', '/')
  const slash = query.lastIndexOf('/')
  if (query === '' || slash >= 0) {
    const directory = slash < 0 ? '' : query.slice(0, slash + 1)
    const fragment = slash < 0 ? '' : query.slice(slash + 1)
    const direct = entries
      .filter((entry) => entry.path.startsWith(directory)
        && entry.path !== directory.replace(/\/$/, '')
        && !entry.path.slice(directory.length).includes('/'))
      .map((entry) => ({ path: entry.path, kind: entry.kind }))
    return rankCandidates(direct, fragment, limit)
  }
  const visible = entries
    .filter((entry) => visibleForGlobalQuery(entry.path, query))
    .filter((entry) => !entry.path.split('/').some((segment) => EXCLUDED.has(segment)))
    .map((entry) => ({ path: entry.path, kind: entry.kind }))
  return rankCandidates(visible, query, limit)
}

function unwrap(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
  try { return value[Symbol.for('cordis.original')] ?? value } catch { return value }
}

/** One broker call to the distro embedded in a WSL UNC cwd. */
function brokerFor(cwd) {
  const match = /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)\\/i.exec(String(cwd ?? ''))
  const distro = match ? match[1] : ''
  const linux = linuxPathFromUnc(cwd) ?? (typeof cwd === 'string' && cwd.startsWith('/') ? cwd : '')
  return registry.get(distro, userFromLinuxPath(linux) || userFor(distro))
}

/**
 * Install the WSL `@file` provider over the Host `fileReferences` service.
 * Non-WSL Agents keep the shipped provider; a broker failure falls back to it.
 *
 * @returns `{ installed, dispose }`; `installed` is a live getter.
 */
export function installWslFileReferences(ctx) {
  const disposers = []
  const caches = new Map()
  let installed = false

  const presetOf = (agent) => {
    try {
      return ctx.get('agentPresets')?.presetForSession?.(agent?.session)
    } catch {
      return undefined
    }
  }
  const cwdOf = (agent) => {
    try {
      return ctx.get('workingDirectory')?.get?.(agent?.session)
    } catch {
      return undefined
    }
  }

  const listFromWsl = async (agent, query, signal) => {
    if (presetOf(agent) !== WSL_PRESET) return undefined
    const cwd = cwdOf(agent)
    const linux = linuxPathFromUnc(cwd) ?? (typeof cwd === 'string' && cwd.startsWith('/') ? cwd : undefined)
    if (linux === undefined) return undefined
    const key = String(agent?.session?.id ?? agent?.session ?? '')
    let cached = caches.get(key)
    if (cached === undefined || cached.cwd !== linux || Date.now() - cached.at > CACHE_MS) {
      signal?.throwIfAborted?.()
      // `glob` already exists in every helper version and respects the Git
      // worktree on 1.0.8+; directories are derived from the file paths.
      const found = await brokerFor(cwd).call('glob', { path: linux, pattern: '**/*', max: MAX_ENTRIES }, { signal })
      const entries = new Map()
      const base = linux.replace(/\/+$/, '')
      for (const full of found.paths ?? []) {
        const rel = String(full).slice(base.length + 1).replace(/\\/g, '/')
        if (rel === '' || rel.startsWith('/')) continue
        const parts = rel.split('/')
        if (parts.some((part) => EXCLUDED.has(part))) continue
        entries.set(rel, 'file')
        for (let i = 1; i < parts.length; i += 1) entries.set(parts.slice(0, i).join('/'), 'directory')
      }
      cached = { cwd: linux, entries: [...entries].map(([path, kind]) => ({ path, kind })), at: Date.now() }
      caches.set(key, cached)
    }
    return candidatesFromEntries(cached.entries, query, MAX_RESULTS)
  }

  const install = (service) => {
    if (installed) return true
    const raw = unwrap(service)
    if (!raw || typeof raw.list !== 'function') return false
    if (raw[PATCH]) { installed = true; return true }
    const original = raw.list
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'list')
    const patched = async function list(agent, query, signal) {
      try {
        const result = await listFromWsl(agent, query, signal)
        if (result !== undefined) return result
      } catch (error) {
        if (signal?.aborted) throw error
      }
      return original.call(raw, agent, query, signal)
    }
    try {
      Object.defineProperty(raw, 'list', { configurable: true, enumerable: false, writable: true, value: patched })
    } catch {
      return false
    }
    const dispose = () => {
      try {
        if (descriptor) Object.defineProperty(raw, 'list', descriptor)
        else delete raw.list
      } catch {}
      try { delete raw[PATCH] } catch {}
    }
    Object.defineProperty(raw, PATCH, { configurable: true, enumerable: false, writable: true, value: dispose })
    disposers.push(dispose)
    installed = true
    return true
  }

  const current = ctx.get('fileReferences')
  if (current) install(current)
  else ctx.on('internal/service', (name, value) => { if (name === 'fileReferences') install(value) })

  // A tool result can add/remove files; the next @ rebuilds the bounded tree.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'tool/result') return
    const key = String(session?.id ?? '')
    if (key) caches.delete(key)
  })

  return {
    get installed() { return installed },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
      caches.clear()
      installed = false
    },
  }
}
