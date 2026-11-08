// `ctx.fs` backed by WSL distributions, so the model's read/write/edit work on
// Linux paths and Linux permissions instead of the Windows UNC share.
//
// Multi-distro: every target key carries its distribution (`wsl:<distro>|<path>`),
// so one provider can serve workspaces from several distributions at once.
//
// Written as a factory (no DSH imports) so it can be tested on its own.
import { posix } from 'node:path'

function fail(code, message, extra) {
  return Object.assign(new Error(message), { code, ...extra })
}

/** Version = mtime+size; enough to detect a stale edit without hashing. */
function versionOf(info) {
  return `${Math.floor(info.mtime)}-${info.size ?? 0}`
}

function hostPathToLinux(value) {
  const raw = String(value ?? '')
  if (raw.startsWith('/')) return raw
  const unc = /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/i.exec(raw)
  if (unc) return `/${unc[2].replace(/\\/g, '/')}`
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(raw)
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
  return undefined
}

function distroFromHostPath(value) {
  const raw = String(value ?? '')
  const unc = /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)\\/i.exec(raw)
  return unc ? unc[1] : undefined
}

/** Apply ordered hunks to text, preserving its line-ending style. */
export function applyHunks(text, hunks) {
  const crlf = text.includes('\r\n')
  const eol = crlf ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const ordered = [...hunks].sort((a, b) => b.lineNumber - a.lineNumber)
  for (const hunk of ordered) {
    const index = hunk.lineNumber - 1
    const oldLines = hunk.oldLines ?? []
    const newLines = hunk.newLines ?? []
    const actual = lines.slice(index, index + oldLines.length)
    if (actual.join('\n') !== oldLines.join('\n')) {
      throw fail('FS_PATCH_MISMATCH', `hunk at line ${hunk.lineNumber} does not match the current content`)
    }
    lines.splice(index, oldLines.length, ...newLines)
  }
  return lines.join(eol)
}

/**
 * @param brokerFor  (distro) => broker — one persistent connection per distro
 * @param defaultDistro  used when a call carries no distribution (empty = WSL default)
 */
export function createWslFileSystem({ brokerFor, defaultDistro = '', defaultCwd = '/' }) {
  const brokerOf = (distro) => brokerFor(distro || defaultDistro)

  const target = (distro, path) => ({
    targetKey: `wsl:${distro}|${path}`,
    displayPath: path,
  })

  const parse = (t) => {
    const raw = String(t?.targetKey ?? '')
    const body = raw.startsWith('wsl:') ? raw.slice(4) : raw
    const at = body.indexOf('|')
    if (at < 0) return { distro: defaultDistro, path: t?.displayPath ?? body }
    return { distro: body.slice(0, at), path: body.slice(at + 1) }
  }

  const normalize = (path, base = defaultCwd) => {
    if (!path) return base
    const joined = path.startsWith('/') ? path : posix.join(base, path)
    return posix.normalize(joined).replace(/\/+$/, '') || '/'
  }

  const statOf = async (path, distro) => {
    try {
      return await brokerOf(distro).call('stat', { path })
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  return {
    /** @inheritdoc */
    async resolve(path, opts = {}) {
      opts.signal?.throwIfAborted()
      const distro = distroFromHostPath(opts.cwd) ?? defaultDistro
      const base = hostPathToLinux(opts.cwd) ?? defaultCwd
      const lexical = normalize(String(path ?? ''), base)
      const real = await brokerOf(distro).call('realpath', { path: lexical }).catch(() => ({ path: null }))
      return target(distro, real?.path ?? lexical)
    },

    processPath(t) {
      return parse(t).path
    },

    processPathFromHostPath(hostPath) {
      return hostPathToLinux(hostPath)
    },

    fileUrl(t) {
      return 'file://' + parse(t).path.split('/').map((s) => encodeURIComponent(s)).join('/')
    },

    contains(parent, child) {
      const p = parse(parent).path.replace(/\/+$/, '') || '/'
      const c = parse(child).path.replace(/\/+$/, '') || '/'
      if (p === '/') return true
      return c === p || c.startsWith(p + '/')
    },

    /** @inheritdoc */
    async stat(t, signal) {
      signal?.throwIfAborted()
      const { distro, path } = parse(t)
      const info = await statOf(path, distro)
      if (!info) return undefined
      return { version: versionOf(info), type: info.type, size: info.size }
    },

    /** @inheritdoc */
    async lstat(path, opts = {}, signal) {
      signal?.throwIfAborted()
      const distro = distroFromHostPath(opts.cwd) ?? defaultDistro
      const base = hostPathToLinux(opts.cwd) ?? defaultCwd
      const lexical = normalize(path, base)
      const info = await brokerOf(distro).call('lstat', { path: lexical })
      if (info.absent) return undefined
      return { version: versionOf(info), type: info.type, size: info.size }
    },

    /** @inheritdoc */
    async readText(t, signal) {
      signal?.throwIfAborted()
      const { distro, path } = parse(t)
      try {
        return (await brokerOf(distro).call('read', { path })).text
      } catch (error) {
        if (error.code === 'ENOENT') throw fail('FS_NOT_FOUND', `no such file: ${path}`)
        if (error.code === 'EISDIR') throw fail('FS_NOT_REGULAR_FILE', `not a regular file: ${path}`)
        throw error
      }
    },

    /** @inheritdoc */
    async *streamText(t, signal) {
      const text = await this.readText(t, signal)
      for (let at = 0; at < text.length; at += 64 * 1024) {
        signal?.throwIfAborted()
        yield text.slice(at, at + 64 * 1024)
      }
    },

    /** @inheritdoc */
    async readBytes(t, _signal, maxBytes) {
      const { distro, path } = parse(t)
      const result = await brokerOf(distro).call('readBytes', { path, maxBytes })
      return Uint8Array.from(Buffer.from(result.base64, 'base64'))
    },

    /** @inheritdoc */
    async readByteRange(t, range, signal) {
      signal?.throwIfAborted()
      const { distro, path } = parse(t)
      const result = await brokerOf(distro).call('readRange', { path, offset: range.offset, length: range.length })
      return Uint8Array.from(Buffer.from(result.base64, 'base64'))
    },

    /** @inheritdoc */
    async listDir(t, signal) {
      signal?.throwIfAborted()
      const { distro, path } = parse(t)
      const listing = await brokerOf(distro).call('list', { path })
      const entries = listing.entries.map((entry) => ({
        name: entry.name,
        type: entry.dir ? 'directory' : entry.link ? 'other' : 'file',
        target: target(distro, posix.join(path, entry.name)),
      }))
      return entries.sort((a, b) => a.name.localeCompare(b.name))
    },

    /** @inheritdoc */
    async writeText(t, content, expected, signal) {
      signal?.throwIfAborted()
      const { distro, path } = parse(t)
      const broker = brokerOf(distro)
      const before = await statOf(path, distro)
      if (expected?.kind === 'createIfAbsent' && before) {
        throw fail('FS_EXISTS', `file already exists: ${path}`)
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!before) throw fail('FS_STALE_VERSION', `file disappeared: ${path}`)
        if (versionOf(before) !== expected.version) {
          throw fail('FS_STALE_VERSION', `file changed since it was read: ${path}`)
        }
      }
      const previous = before ? await this.readText(t, signal).catch(() => null) : null
      await broker.call('write', { path, text: content })
      const after = await statOf(path, distro)
      return {
        operation: before ? 'update' : 'create',
        version: after ? versionOf(after) : '0-0',
        before: previous,
        after: content,
      }
    },

    /** @inheritdoc */
    async editText(t, edit, expected, signal) {
      signal?.throwIfAborted()
      const { distro, path } = parse(t)
      const before = await statOf(path, distro)
      if (!before) throw fail('FS_NOT_FOUND', `no such file: ${path}`)
      if (expected?.version && versionOf(before) !== expected.version) {
        throw fail('FS_STALE_VERSION', `file changed since it was read: ${path}`)
      }
      const current = await this.readText(t, signal)
      const { oldString, newString, replaceAll = false } = edit
      const occurrences = oldString === '' ? 0 : current.split(oldString).length - 1
      if (occurrences === 0) throw fail('FS_EDIT_NO_MATCH', `oldString not found in ${path}`)
      if (occurrences > 1 && !replaceAll) {
        throw fail('FS_EDIT_NOT_UNIQUE', `oldString appears ${occurrences} times in ${path}`)
      }
      const after = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString)
      await brokerOf(distro).call('write', { path, text: after })
      const info = await statOf(path, distro)
      return { version: info ? versionOf(info) : '0-0', before: current, after }
    },

    /** @inheritdoc */
    async patchText(t, hunks, expected, signal) {
      signal?.throwIfAborted()
      const { distro, path } = parse(t)
      const before = await statOf(path, distro)
      if (!before) throw fail('FS_STALE_VERSION', `file disappeared before patching: ${path}`)
      if (expected?.version && versionOf(before) !== expected.version) {
        throw fail('FS_STALE_VERSION', `file changed since it was read: ${path}`)
      }
      const current = await this.readText(t, signal)
      const after = applyHunks(current, hunks)
      await brokerOf(distro).call('write', { path, text: after })
      const info = await statOf(path, distro)
      return { version: info ? versionOf(info) : '0-0', before: current, after }
    },

    /** @inheritdoc */
    async deleteFile(t, expected, signal) {
      signal?.throwIfAborted()
      const { distro, path } = parse(t)
      const info = await statOf(path, distro)
      if (!info) throw fail('FS_NOT_FOUND', `no such file: ${path}`)
      if (info.type !== 'file') throw fail('FS_NOT_REGULAR_FILE', `not a regular file: ${path}`)
      if (expected?.version && versionOf(info) !== expected.version) {
        throw fail('FS_STALE_VERSION', `file changed since it was read: ${path}`)
      }
      const before = await this.readText(t, signal).catch(() => null)
      await brokerOf(distro).call('rm', { path })
      return { before }
    },

    /** @inheritdoc */
    async moveFile(source, destination, options = {}, signal) {
      signal?.throwIfAborted()
      const from = parse(source)
      const to = parse(destination)
      if (from.distro === to.distro && from.path === to.path) throw fail('FS_SAME_TARGET', 'source and destination are the same file')

      const beforeText = await this.readText(source, signal)
      const text = options.hunks?.length ? applyHunks(beforeText, options.hunks) : beforeText

      const destStat = await statOf(to.path, to.distro)
      const guard = options.expectedDestination
      if (guard?.kind === 'createIfAbsent' && destStat) throw fail('FS_EXISTS', `destination exists: ${to.path}`)
      if (guard?.kind === 'replaceIfVersion') {
        if (!destStat) throw fail('FS_STALE_VERSION', `destination disappeared: ${to.path}`)
        if (versionOf(destStat) !== guard.version) throw fail('FS_STALE_VERSION', `destination changed: ${to.path}`)
      }

      await brokerOf(to.distro).call('write', { path: to.path, text })
      const destInfo = await statOf(to.path, to.distro)
      const destinationOutcome = {
        operation: destStat ? 'update' : 'create',
        version: destInfo ? versionOf(destInfo) : '0-0',
        before: destStat ? await this.readText(destination, signal).catch(() => null) : null,
        after: text,
      }

      try {
        await brokerOf(from.distro).call('rm', { path: from.path })
      } catch (error) {
        return {
          sourceBefore: beforeText,
          destination: destinationOutcome,
          sourceDeleted: false,
          sourceFailure: { code: error.code ?? 'FS_MOVE_SOURCE', message: String(error.message ?? error) },
        }
      }
      return { sourceBefore: beforeText, destination: destinationOutcome, sourceDeleted: true }
    },

    async watch() {
      throw fail('FS_UNSUPPORTED', 'the WSL filesystem exposes no watcher; collect once instead of watching')
    },
  }
}
