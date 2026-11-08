// WSL execution world for the ctx.subprocess seam.
// Written as a factory so it can be tested without DSH; the plugin wraps it in
// a `SubprocessRuntime` subclass (see index.js).
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { Collector } from './collector.mjs'
import { parseWslUnc } from './broker.mjs'
import { buildArgv } from './launch.mjs'

const LOG = 'C:\\Users\\Yunson\\dsh-wsl-plugin\\wsl-world.log'
const DEBUG = process.env.DSH_WSL_DEBUG === '1'
const trace = (line) => { if (DEBUG) try { appendFileSync(LOG, `${new Date().toISOString()} sub: ${line}\n`) } catch {} }

const WSL_EXE = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wsl.exe`

/** Accept a Linux path, a `\\wsl.localhost\...` path, or a `C:\...` path. */
export function toLinuxCwd(cwd, distro) {
  if (!cwd) return undefined
  if (cwd.startsWith('/')) return cwd
  const unc = parseWslUnc(cwd)
  if (unc) {
    if (unc.distro.toLowerCase() !== distro.toLowerCase()) {
      throw Object.assign(new Error(`cwd 属于另一个发行版：${unc.distro}`), { code: 'FS_BAD_PATH' })
    }
    return unc.linuxPath
  }
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(cwd)
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
  return cwd
}

function collect(mode) {
  if (mode === 'pipe' || mode === 'inherit') return { kind: mode, collector: null }
  if (mode && typeof mode.maxBytes === 'number') return { kind: 'collect', collector: new Collector(mode.maxBytes) }
  throw Object.assign(new Error('subprocess-wsl: invalid stdio mode'), { code: 'SUBPROCESS_INVALID_SPEC' })
}

export function createWslSubprocess({ broker, distro, user = '', ptyDelegate, onExit } = {}) {
  const live = new Set()

  /**
   * Everything travels inside ONE base64-encoded `-c` script (see launch.mjs):
   * wsl.exe drops trailing arguments and pre-expands `$VAR` against the dirty
   * target environment, so nothing else survives intact.
   */
  function argvFor(spec, cwd) {
    const args = buildArgv(spec, { distro, user, cwd, path: broker?.cleanPath })
    trace(`spawn ${JSON.stringify(args)}`)
    return args
  }

  function validate(spec) {
    if (!spec || !Array.isArray(spec.argv) || spec.argv.length === 0) {
      throw Object.assign(new Error('subprocess-wsl: argv must name a program'), { code: 'SUBPROCESS_INVALID_SPEC' })
    }
    if (spec.signal?.aborted) throw Object.assign(new Error('subprocess-wsl: aborted'), { code: 'SUBPROCESS_ABORTED' })
  }

  return {
    /** @inheritdoc */
    async resolveExecutable(command, env, signal) {
      signal?.throwIfAborted()
      if (!command) throw Object.assign(new Error('subprocess-wsl: empty command'), { code: 'SUBPROCESS_INVALID_SPEC' })
      if (command.includes('/') && !command.startsWith('/')) {
        throw Object.assign(new Error(`subprocess-wsl: relative path is ambiguous: ${command}`), { code: 'SUBPROCESS_INVALID_SPEC' })
      }
      const found = await broker.call('which', { command, env }, { signal })
      if (!found?.path) {
        throw Object.assign(new Error(`subprocess-wsl: command not found in ${distro}: ${command}`), { code: 'SUBPROCESS_EXECUTABLE_NOT_FOUND' })
      }
      return found.path
    },

    /** @inheritdoc */
    async terminalEnvironment(signal) {
      signal?.throwIfAborted()
      const shell = broker.hello?.shell ?? '/bin/bash'
      return { platform: 'posix', defaultShell: shell }
    },

    /** @inheritdoc */
    spawn(spec) {
      validate(spec)
      const cwd = toLinuxCwd(spec.cwd, distro)
      const stdinMode = spec.stdio.stdin
      const out = collect(spec.stdio.stdout)
      const err = collect(spec.stdio.stderr)
      const stdio = [
        stdinMode === 'pipe' ? 'pipe' : stdinMode === 'ignore' ? 'ignore' : 'pipe',
        out.kind === 'inherit' ? 'inherit' : 'pipe',
        err.kind === 'inherit' ? 'inherit' : 'pipe',
      ]
      const child = nodeSpawn(WSL_EXE, argvFor(spec, cwd), { windowsHide: true, stdio })
      if (out.kind === 'pipe' || err.kind === 'pipe') {
        // Raw streams belong to the caller; nothing is buffered here.
      }
      if (out.collector) child.stdout.on('data', (d) => out.collector.write(d))
      if (err.collector) child.stderr.on('data', (d) => err.collector.write(d))
      if (typeof stdinMode === 'object' && stdinMode && typeof stdinMode.data === 'string') {
        child.stdin.end(stdinMode.data)
      }
      if (spec.signal) {
        const onAbort = () => { try { terminate() } catch {} }
        spec.signal.addEventListener('abort', onAbort, { once: true })
        child.once('close', () => spec.signal.removeEventListener('abort', onAbort))
      }

      let settled = false
      let terminated = false
      const done = new Promise((resolve, reject) => {
        child.on('error', (error) => { if (!settled) { settled = true; reject(error) } })
        child.on('close', (code, signal) => {
          if (settled) return
          settled = true
          live.delete(handle)
          onExit?.(handle)
          resolve({ exitCode: code, signal: signal ?? null })
        })
      })

      function terminate() {
        if (terminated || settled) return
        terminated = true
        if (process.platform === 'win32' && child.pid) {
          // Kill the whole tree: wsl.exe plus the Windows-side relay.
          execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], () => {})
        } else {
          try { child.kill('SIGKILL') } catch {}
        }
      }

      const handle = {
        stdin: child.stdin ?? undefined,
        stdout: out.kind === 'pipe' ? child.stdout : undefined,
        stderr: err.kind === 'pipe' ? child.stderr : undefined,
        control: undefined,
        collected: {
          stdout: out.collector ? { readFrom: (o) => out.collector.readFrom(o) } : undefined,
          stderr: err.collector ? { readFrom: (o) => err.collector.readFrom(o) } : undefined,
        },
        done,
        terminate,
        async waitForExit() { await done.catch(() => {}); return true },
      }
      live.add(handle)
      done.catch(() => {}).finally(() => live.delete(handle))
      return handle
    },

    /** @inheritdoc */
    async spawnTerminal(spec, delegate = ptyDelegate) {
      if (!delegate) {
        throw Object.assign(new Error('subprocess-wsl: no PTY delegate mounted; the sidebar terminal is unavailable'), { code: 'SUBPROCESS_UNSUPPORTED' })
      }
      const cwd = toLinuxCwd(spec.cwd, distro)
      const args = ['-d', distro]
      if (user) args.push('-u', user)
      if (cwd) args.push('--cd', cwd)
      args.push('--', ...spec.argv)
      // Delegate to the host's real PTY: wsl.exe allocates the tty, the
      // Linux-side bash inherits it. This is why the world needs the local
      // provider captured before it is shadowed.
      return delegate.spawnTerminal({
        ...spec,
        argv: [WSL_EXE, ...args],
        cwd: process.env.SystemRoot ?? 'C:\\Windows',
        env: { ...(spec.env ?? {}) },
      })
    },

    /** Terminate everything this provider still manages (service disposal). */
    async dispose() {
      for (const handle of [...live]) {
        try { handle.terminate() } catch {}
      }
      for (const handle of [...live]) await handle.waitForExit().catch(() => {})
      live.clear()
    },
  }
}
