// Runs inside the distro. NDJSON over stdio; no network, no ports.
// Sanitises PATH (drops Windows interop entries) at startup — see PLAN §12.4.
const cleanPath = (process.env.PATH ?? '')
  .split(':')
  .filter((p) => p && !/^\/mnt\/[a-z](\/|$)/i.test(p))
  .join(':')
process.env.PATH = cleanPath

import { createInterface } from 'node:readline'
import { promises as fsp } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let jobs = new Map()

function hello() {
  return {
    v: 1,
    pid: process.pid,
    user: process.env.USER ?? process.env.LOGNAME ?? '',
    home: process.env.HOME ?? '',
    shell: process.env.SHELL || '/bin/bash',
    cwd: process.cwd(),
    path: process.env.PATH,
    node: process.execPath,
  }
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Minimal glob → RegExp: `**`, `*`, `?`, `[...]`, `{a,b}`. */
function globToRegExp(glob) {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1
        if (glob[i + 1] === '/') { i += 1; out += '(?:.*/)?' } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end === -1) out += '\\['
      else { out += '[' + glob.slice(i + 1, end).replace(/^!/, '^') + ']'; i = end }
    } else if (c === '{') {
      const end = glob.indexOf('}', i + 1)
      if (end === -1) out += '\\{'
      else { out += '(?:' + glob.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')'; i = end }
    } else {
      out += escapeRe(c)
    }
  }
  return new RegExp(out + '$')
}

/** Depth-first file walk; VCS metadata and dependency trees are pruned. */
async function walk(root, visit) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        stack.push(full)
      } else if (entry.isFile()) {
        if (visit(full) === false) return
      }
    }
  }
}

/**
 * Files of a Git worktree, respecting `.gitignore` (the `--exclude-standard`
 * set) and nested ignore files. Returns null outside a worktree, where the
 * caller falls back to `walk` (which prunes `.git`/`node_modules`).
 */
async function listGitFiles(root) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', root,
      '-c', 'core.quotepath=false',
      'ls-files', '-z',
      '--cached', '--others', '--exclude-standard',
    ], { maxBuffer: 64 * 1024 * 1024 })
    return stdout.split('\0').filter(Boolean).map((rel) => path.join(root, rel))
  } catch {
    return null
  }
}

/**
 * Prefer ripgrep's file walk when the distribution has it: it also honours
 * `.ignore`, `.rgignore` and nested ignore files, which `git ls-files` does
 * not. Falls back to the Git list.
 */
async function listFiles(root) {
  try {
    const { stdout } = await execFileAsync('rg', [
      '--files', '--hidden', '-0',
      '--glob', '!.git', '--glob', '!.git/**',
      '--glob', '!node_modules', '--glob', '!node_modules/**',
    ], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    return stdout.split('\0').filter(Boolean).map((rel) => path.join(root, rel))
  } catch {
    return await listGitFiles(root)
  }
}

/** Run one git command in a worktree with an optional private index. */
async function git(cwd, args, env) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : undefined,
  })
  return stdout.trim()
}

/** `git rev-parse --show-prefix` for a cwd below the repository root. */
async function gitPrefix(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--show-prefix'])).replace(/\r/g, '')
  } catch {
    return ''
  }
}

/** Snapshot the work tree's non-ignored state into a tree object. */
async function gitSnapshot(cwd) {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'dsh-wsl-git-'))
  const index = path.join(dir, 'index')
  const env = { GIT_INDEX_FILE: index }
  try {
    await git(cwd, ['read-tree', '--empty'], env)
    await git(cwd, ['add', '-A', '--', '.', ':(exclude).agents/worktrees'], env)
    const tree = await git(cwd, ['write-tree'], env)
    return { tree }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** numstat between two trees, with paths relative to `cwd`. */
async function gitSummary(cwd, before, after) {
  const prefix = await gitPrefix(cwd)
  const raw = await git(cwd, ['diff-tree', '-r', '--no-commit-id', '--numstat', '--no-renames', before, after])
  const files = []
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(\S+)\t(\S+)\t(.*)$/.exec(line)
    if (!match) continue
    let file = match[3]
    if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length)
    const binary = match[1] === '-' && match[2] === '-'
    files.push({ path: file, added: binary ? 0 : Number(match[1]) || 0, deleted: binary ? 0 : Number(match[2]) || 0, ...(binary ? { binary: true } : {}) })
  }
  return { files }
}

function parseUnifiedDiff(raw, pathValue, display, before, after, coarse) {
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
    if (line.startsWith('diff --git ') || line.startsWith('index ')) continue
    if (line.startsWith('\\ No newline')) { current.lines.push(line); continue }
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) current.lines.push(line)
  }
  if (current) hunks.push(current)
  return { kind: 'text', path: pathValue, display, before, after, hunks, coarse }
}

/** One file's before/after comparison from two tree objects. */
async function gitDiffFile(cwd, before, after, file) {
  const prefix = await gitPrefix(cwd)
  const full = `${prefix}${file}`
  const exists = async (tree) => {
    try {
      await git(cwd, ['cat-file', '-e', `${tree}:${full}`])
      return true
    } catch {
      return false
    }
  }
  const beforeExists = await exists(before)
  const afterExists = await exists(after)
  let size = 0
  if (afterExists) {
    try { size = Number(await git(cwd, ['cat-file', '-s', `${after}:${full}`])) || 0 } catch {}
  }
  if (size > 2 * 1024 * 1024) return { kind: 'oversized', path: file, display: file }
  const raw = await git(cwd, ['diff', '--no-color', '--unified=3', before, after, '--', full])
  if (/^Binary files /m.test(raw)) return { kind: 'binary', path: file, display: file }
  return parseUnifiedDiff(raw, file, file, beforeExists, afterExists, false)
}

/** Directory basenames the `@` index never descends into. */
const INDEX_EXCLUDED = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.turbo', '.venv', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.gradle',
])

function relativeParts(root, full) {
  return full.slice(root.length + 1).replace(/\\/g, '/').split('/').filter(Boolean)
}

/**
 * The bounded file+directory index used by `@` completion. In a Git worktree
 * the file set is `git ls-files --exclude-standard` (`.gitignore` respected)
 * and directories are derived from those paths; outside one it walks. Returns
 * at most `max` entries, both with paths relative to `root`.
 */
async function listTree(root, max) {
  const entries = new Map()
  const files = await listFiles(root)
  if (files !== null) {
    for (const full of files.sort()) {
      const parts = relativeParts(root, full)
      if (parts.length === 0 || parts.some((part) => INDEX_EXCLUDED.has(part))) continue
      entries.set(parts.join('/'), 'file')
      for (let i = 1; i < parts.length; i += 1) entries.set(parts.slice(0, i).join('/'), 'directory')
      if (entries.size >= max) break
    }
  } else {
    const stack = [{ abs: root, rel: '' }]
    while (stack.length > 0 && entries.size < max) {
      const current = stack.pop()
      let children
      try { children = await fsp.readdir(current.abs, { withFileTypes: true }) } catch { continue }
      for (const child of children) {
        const rel = current.rel === '' ? child.name : `${current.rel}/${child.name}`
        if (child.isDirectory()) {
          if (INDEX_EXCLUDED.has(child.name)) continue
          entries.set(rel, 'directory')
          stack.push({ abs: path.join(current.abs, child.name), rel })
        } else if (child.isFile()) {
          entries.set(rel, 'file')
        }
      }
    }
  }
  return { entries: [...entries].map(([entryPath, kind]) => ({ path: entryPath, kind })) }
}

async function handle(req) {
  switch (req.op) {
    case 'ping':
      return { pong: true, pid: process.pid, cwd: process.cwd() }
    case 'stat': {
      const s = await fsp.stat(req.path)
      return { type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size, mtime: s.mtimeMs, mode: (s.mode & 0o777).toString(8) }
    }
    case 'lstat': {
      try {
        const s = await fsp.lstat(req.path)
        return {
          type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other',
          size: s.size,
          mtime: s.mtimeMs,
        }
      } catch (error) {
        if (error.code === 'ENOENT') return { absent: true }
        throw error
      }
    }
    case 'realpath': {
      try { return { path: await fsp.realpath(req.path) } } catch (error) {
        if (error.code === 'ENOENT') return { path: null }
        throw error
      }
    }
    case 'gitSnapshot': {
      return await gitSnapshot(req.cwd)
    }
    case 'gitSummary': {
      return await gitSummary(req.cwd, req.before, req.after)
    }
    case 'gitDiffFile': {
      return await gitDiffFile(req.cwd, req.before, req.after, req.path)
    }
    case 'tree': {
      const { path: root, max = 50_000 } = req
      return await listTree(root, max)
    }
    case 'glob': {
      const { path: root, pattern = '**/*', max = 1000 } = req
      const re = globToRegExp(pattern)
      const base = root.replace(/\/+$/, '')
      const found = []
      let truncated = false
      const visit = (file) => {
        const rel = file.slice(base.length + 1)
        const name = path.basename(file)
        if (re.test(rel) || re.test(name)) {
          found.push(file)
          if (found.length >= max) { truncated = true; return false }
        }
        return true
      }
      const gitFiles = await listFiles(root)
      if (gitFiles === null) await walk(root, visit)
      else for (const file of gitFiles.sort()) { if (visit(file) === false) break }
      found.sort()
      return { paths: found, truncated, total: found.length }
    }
    case 'grep': {
      const { path: root, pattern, include, max = 250 } = req
      let re
      try { re = new RegExp(pattern) } catch (error) {
        throw Object.assign(new Error(`invalid regular expression: ${error.message}`), { code: 'FS_BAD_PATTERN' })
      }
      const includeRe = include ? globToRegExp(include) : null
      const files = []
      const addFile = (file) => {
        if (includeRe && !includeRe.test(path.basename(file))) return true
        files.push(file)
        return true
      }
      const gitFiles = await listFiles(root)
      if (gitFiles === null) await walk(root, addFile)
      else for (const file of gitFiles.sort()) addFile(file)
      const matches = []
      let seen = 0
      let truncated = false
      for (const file of files) {
        let text
        try {
          const info = await fsp.stat(file)
          if (info.size > 2 * 1024 * 1024) continue
          text = await fsp.readFile(file, 'utf8')
        } catch { continue }
        if (text.includes('\u0000')) continue // binary
        const lines = text.split('\n')
        const hits = []
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue
          hits.push({ lineNumber: i + 1, line: lines[i].slice(0, 2000) })
          seen += 1
          if (seen >= max) { truncated = true; break }
        }
        if (hits.length > 0) matches.push({ path: file, matches: hits })
        if (truncated) break
      }
      return { files: matches, truncated, total: seen }
    }
    case 'rm': {
      await fsp.unlink(req.path)
      return { removed: true }
    }
    case 'readBytes': {
      const buf = await fsp.readFile(req.path)
      const cap = req.maxBytes ?? 0
      if (cap > 0 && buf.length > cap) {
        throw Object.assign(new Error(`file is larger than ${cap} bytes`), { code: 'FS_TOO_LARGE' })
      }
      return { base64: buf.toString('base64'), bytes: buf.length }
    }
    case 'readRange': {
      const handle = await fsp.open(req.path, 'r')
      try {
        const buf = Buffer.alloc(req.length)
        const { bytesRead } = await handle.read(buf, 0, req.length, req.offset)
        return { base64: buf.subarray(0, bytesRead).toString('base64'), bytes: bytesRead }
      } finally {
        await handle.close()
      }
    }
    case 'read':
      return { text: await fsp.readFile(req.path, 'utf8') }
    case 'list':
      return { entries: (await fsp.readdir(req.path, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory(), link: e.isSymbolicLink() })) }
    case 'write': {
      const dir = path.dirname(req.path)
      await fsp.mkdir(dir, { recursive: true })
      const tmp = path.join(dir, `.dsh-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const mode = req.mode ? parseInt(req.mode, 8) : undefined
      try {
        if (mode) await fsp.writeFile(tmp, req.text, { encoding: 'utf8', mode })
        else await fsp.writeFile(tmp, req.text, 'utf8')
        await fsp.rename(tmp, req.path)
      } catch (error) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw error
      }
      return { bytes: Buffer.byteLength(req.text) }
    }
    case 'exec': {
      // Bounded one-shot; the plugin's subprocess provider drives longer work.
      return await new Promise((resolve) => {
        const child = spawn(req.argv[0], req.argv.slice(1), { cwd: req.cwd, env: { ...process.env, ...(req.env ?? {}) } })
        let out = '', err = '', truncated = false
        const cap = req.maxBytes ?? 1 << 20
        child.stdout.on('data', (d) => { if (out.length < cap) out += d.toString('utf8'); else truncated = true })
        child.stderr.on('data', (d) => { if (err.length < cap) err += d.toString('utf8'); else truncated = true })
        child.on('error', (e) => resolve({ code: -1, out, err: err + String(e), truncated }))
        child.on('close', (code, signal) => resolve({ code, signal, out, err, truncated }))
      })
    }
    case 'which': {
      const { command } = req
      const searchPath = (req.env?.PATH ?? process.env.PATH ?? '').split(':').filter(Boolean)
      const candidates = command.startsWith('/')
        ? [command]
        : searchPath.map((dir) => path.join(dir, command))
      for (const candidate of candidates) {
        if (/^\/mnt\/[a-z]\//i.test(candidate)) continue // interop binary: never hand it out
        try {
          await fsp.access(candidate, (await import('node:fs')).constants.X_OK)
          const real = await fsp.realpath(candidate).catch(() => candidate)
          return { path: candidate, real }
        } catch {}
      }
      return { path: null }
    }
    case 'shutdown':
      process.stdout.write(JSON.stringify({ id: req.id, result: { bye: true } }) + '\n', () => process.exit(0))
      return undefined
    default:
      throw Object.assign(new Error(`unknown op: ${req.op}`), { code: 'EUNKNOWNOP' })
  }
}

rl.on('line', (line) => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return }
  handle(req).then(
    (result) => { if (result !== undefined) process.stdout.write(JSON.stringify({ id: req.id, result }) + '\n') },
    (error) => process.stdout.write(JSON.stringify({ id: req.id, error: { code: error.code ?? 'EFAIL', message: String(error.message ?? error) } }) + '\n'),
  )
})

process.stdout.write(JSON.stringify({ event: 'hello', result: hello() }) + '\n')
