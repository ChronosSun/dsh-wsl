// WSL-side workspace-change summaries and diffs.
//
// The shipped `workspaceChanges` recorder is a Host service: it runs Windows
// git against the UNC worktree. This companion takes a snapshot inside the
// distribution at `turn/start` and `turn/end` (private GIT_INDEX_FILE, then
// write-tree/diff-tree), stores the summary by the `workspace/changes` event's
// seq, and serves it before the Host fallback. The Host summary's `cwd`/`path`
// stay usable for `/api/changes.open`; only the comparison work moves to Linux.
import { registry } from './registry.mjs'
import { linuxPathFromUnc } from './preset-default.mjs'
import { userFor } from './settings.mjs'

export const WSL_PRESET = 'wsl'
const PATCH = Symbol.for('dsh-wsl/wsl-diff')
const MAX_ENTRIES = 500

function unwrap(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
  try { return value[Symbol.for('cordis.original')] ?? value } catch { return value }
}

function linuxCwd(session) {
  const cwd = session?.header?.cwd
  return linuxPathFromUnc(cwd) ?? (typeof cwd === 'string' && cwd.startsWith('/') ? cwd : undefined)
}

function brokerFor(cwd) {
  const match = /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)\\/i.exec(String(cwd ?? ''))
  const distro = match ? match[1] : ''
  return registry.get(distro, userFor(distro))
}

/** A running helper from before the git ops were added still has `exec`. */
async function exec(broker, argv, cwd) {
  return broker.call('exec', { argv, cwd })
}

/**
 * `gitSnapshot` with a shell fallback so a Session whose helper predates the
 * operation still gets a WSL snapshot instead of the Host fallback.
 */
async function snapshotInWsl(broker, cwd) {
  const script = [
    'set -e',
    'd=$(mktemp -d)',
    'trap \'rm -rf "$d"\' EXIT',
    'export GIT_INDEX_FILE="$d/index"',
    'git -C "$PWD" read-tree --empty',
    "git -C \"$PWD\" add -A -- . ':(exclude).agents/worktrees'",
    'git -C "$PWD" write-tree',
  ].join('\n')
  const result = await exec(broker, ['bash', '-c', script], cwd)
  if (result.code !== 0) throw new Error(`wsl-diff: snapshot failed: ${result.err || result.out}`)
  const lines = result.out.trim().split(/\r?\n/)
  const tree = lines[lines.length - 1]?.trim()
  if (!tree) throw new Error('wsl-diff: snapshot produced no tree')
  return tree
}

async function summaryInWsl(broker, cwd, before, after) {
  const prefix = (await exec(broker, ['git', '-C', cwd, 'rev-parse', '--show-prefix'], cwd)).out.trim()
  const raw = await exec(broker, ['git', '-C', cwd, 'diff-tree', '-r', '--no-commit-id', '--numstat', '--no-renames', before, after], cwd)
  if (raw.code !== 0) throw new Error(`wsl-diff: summary failed: ${raw.err || raw.out}`)
  const files = []
  for (const line of raw.out.split(/\r?\n/)) {
    const match = /^(\S+)\t(\S+)\t(.*)$/.exec(line)
    if (!match) continue
    let file = match[3]
    if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length)
    const binary = match[1] === '-' && match[2] === '-'
    files.push({ path: file, added: binary ? 0 : Number(match[1]) || 0, deleted: binary ? 0 : Number(match[2]) || 0, ...(binary ? { binary: true } : {}) })
  }
  return files
}

function parseHunks(raw, pathValue, before, after) {
  const hunks = []
  let current = null
  for (const line of raw.split(/\r?\n/)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      if (current) hunks.push(current)
      current = {
        oldStart: Number(header[1]),
        oldLines: Number(header[2] ?? 1),
        newStart: Number(header[3]),
        newLines: Number(header[4] ?? 1),
        lines: [],
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('\\ No newline')) { current.lines.push(line); continue }
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) current.lines.push(line)
  }
  if (current) hunks.push(current)
  return { kind: 'text', path: pathValue, display: pathValue, before, after, hunks, coarse: false }
}

async function diffInWsl(broker, cwd, before, after, file) {
  const prefix = (await exec(broker, ['git', '-C', cwd, 'rev-parse', '--show-prefix'], cwd)).out.trim()
  const full = `${prefix}${file}`
  const exists = async (tree) => {
    const result = await exec(broker, ['git', '-C', cwd, 'cat-file', '-e', `${tree}:${full}`], cwd)
    return result.code === 0
  }
  const beforeExists = await exists(before)
  const afterExists = await exists(after)
  if (afterExists) {
    const size = await exec(broker, ['git', '-C', cwd, 'cat-file', '-s', `${after}:${full}`], cwd)
    if (Number(size.out) > 2 * 1024 * 1024) return { kind: 'oversized', path: file, display: file }
  }
  const raw = await exec(broker, ['git', '-C', cwd, 'diff', '--no-color', '--unified=3', before, after, '--', full], cwd)
  if (raw.code !== 0) throw new Error(`wsl-diff: diff failed: ${raw.err || raw.out}`)
  if (/^Binary files /m.test(raw.out)) return { kind: 'binary', path: file, display: file }
  return parseHunks(raw.out, file, beforeExists, afterExists)
}

/**
 * Install the WSL recorder companion. Sessions outside `wsl` and sessions
 * without a Linux seed are untouched; every failure falls back to the Host.
 *
 * @returns `{ installed, dispose }`; `installed` is a live getter.
 */
export function installWslDiff(ctx) {
  const disposers = []
  const states = new Map()
  const bySeq = new Map()
  const seqByTurn = new Map()
  const stats = { events: 0, wslEvents: 0, starts: 0, ends: 0, summaries: 0, late: 0, errors: 0, lastError: '' }
  let installed = false

  const presetOf = (session) => {
    try { return ctx.get('agentPresets')?.presetForSession?.(session) } catch { return undefined }
  }
  const isWsl = (session) => presetOf(session) === WSL_PRESET && linuxCwd(session) !== undefined

  const stateFor = (session) => {
    let state = states.get(session.id)
    if (state === undefined) {
      state = { beforeTree: null, pending: null, busy: false }
      states.set(session.id, state)
    }
    return state
  }

  const snapshot = async (session) => {
    const cwd = linuxCwd(session)
    return snapshotInWsl(brokerFor(session.header.cwd), cwd)
  }

  const remember = (sessionId, seq, pending) => {
    bySeq.set(`${sessionId}|${seq}`, pending)
    if (bySeq.size > MAX_ENTRIES) {
      const first = bySeq.keys().next().value
      if (first !== undefined) bySeq.delete(first)
    }
  }

  const onSessionEvent = (session, event) => {
    stats.events += 1
    if (!isWsl(session)) return
    stats.wslEvents += 1
    const turn = Number(event?.data?.turn)
    if (!Number.isFinite(turn)) return
    if (event.type === 'turn/start') {
      stats.starts += 1
      const state = stateFor(session)
      state.beforeTree = null
      state.pending = null
      const tree = snapshot(session)
      tree.then((value) => { state.beforeTree = value }).catch((error) => {
        stats.errors += 1
        stats.lastError = String(error?.message ?? error)
      })
      return
    }
    if (event.type === 'turn/end') {
      stats.ends += 1
      const state = stateFor(session)
      if (state.busy) return
      state.busy = true
      const cwd = session.header.cwd
      const linux = linuxCwd(session)
      const run = (async () => {
        // Wait for the start tree; the Agent's own turn start usually lands
        // well before its first tool call, but a slow git start must not make
        // an empty diff.
        for (let i = 0; i < 50 && state.beforeTree === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
        const after = await snapshot(session)
        if (state.beforeTree === null) throw new Error('wsl-diff: no start tree')
        const files = await summaryInWsl(brokerFor(cwd), linux, state.beforeTree, after)
        const pending = { turn, before: state.beforeTree, after, cwd, files }
        state.pending = pending
        stats.summaries += 1
        const key = `${session.id}|${turn}`
        const seq = seqByTurn.get(key)
        if (seq !== undefined) {
          seqByTurn.delete(key)
          state.pending = null
          remember(session.id, seq, pending)
          stats.late += 1
        }
      })().catch((error) => {
        stats.errors += 1
        stats.lastError = String(error?.message ?? error)
      }).finally(() => { state.busy = false })
      void run
      return
    }
    if (event.type === 'workspace/changes') {
      const key = `${session.id}|${turn}`
      seqByTurn.set(key, event.seq)
      if (seqByTurn.size > MAX_ENTRIES) {
        const first = seqByTurn.keys().next().value
        if (first !== undefined) seqByTurn.delete(first)
      }
      const state = states.get(session.id)
      const pending = state?.pending
      if (pending === undefined || pending === null || pending.turn !== turn) return
      seqByTurn.delete(key)
      state.pending = null
      remember(session.id, event.seq, pending)
    }
  }
  // Prepended so the WSL snapshot starts before the Host recorder's Windows
  // git runs over the UNC worktree; the `workspace/changes` event is appended
  // after that Host work, so the summary is usually ready by then.
  ctx.on('session/event', onSessionEvent, { prepend: true })

  const install = (service) => {
    if (installed) return true
    const raw = unwrap(service)
    if (!raw || typeof raw.summary !== 'function' || typeof raw.diff !== 'function') return false
    if (raw[PATCH]) { installed = true; return true }
    const summaryDescriptor = Object.getOwnPropertyDescriptor(raw, 'summary')
    const diffDescriptor = Object.getOwnPropertyDescriptor(raw, 'diff')
    const originalSummary = raw.summary
    const originalDiff = raw.diff

    const summary = function summaryPatched(sessionId, seq) {
      const ours = bySeq.get(`${sessionId}|${seq}`)
      if (ours === undefined) return originalSummary.call(raw, sessionId, seq)
      const files = ours.files.map((file) => ({
        path: file.path,
        display: file.path,
        added: file.added,
        deleted: file.deleted,
        ...(file.binary === true ? { binary: true } : {}),
      }))
      return {
        turn: ours.turn,
        cwd: ours.cwd,
        source: 'wsl',
        files,
        total: files.length,
        added: files.reduce((sum, file) => sum + file.added, 0),
        deleted: files.reduce((sum, file) => sum + file.deleted, 0),
      }
    }

    const diff = async function diffPatched(sessionId, seq, index, signal) {
      const ours = bySeq.get(`${sessionId}|${seq}`)
      if (ours === undefined) return originalDiff.call(raw, sessionId, seq, index, signal)
      const file = ours.files[index]
      if (file === undefined) return undefined
      signal?.throwIfAborted?.()
      try {
        const broker = brokerFor(ours.cwd)
        const cwd = linuxPathFromUnc(ours.cwd)
        return await diffInWsl(broker, cwd, ours.before, ours.after, file.path)
      } catch {
        return originalDiff.call(raw, sessionId, seq, index, signal)
      }
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

  ctx.on('agent/disposed', ({ agent }) => {
    const id = agent?.session?.id
    if (id === undefined) return
    states.delete(id)
    for (const key of bySeq.keys()) if (key.startsWith(`${id}|`)) bySeq.delete(key)
  })

  return {
    get installed() { return installed },
    get stats() { return { ...stats, sessions: states.size, entries: bySeq.size } },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
      states.clear()
      bySeq.clear()
      installed = false
    },
  }
}
