// One WslBroker per (distro, user), shared by every session and workspace.
// Plain ESM, no DSH dependency — testable on its own (see test/broker.test.mjs).
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HELPER_VERSION = 1

/**
 * Enter the Linux world with a PATH that cannot resolve Windows binaries.
 * Measured on this machine: without this, every wsl.exe-launched process sees
 * ~20 `/mnt/...` entries (Windows node, npm, git, rg, powershell), and
 * `env PATH=` / `env -i` do NOT survive WSL's interop PATH rewrite — only an
 * in-process assignment before exec does.
 */
export const EXEC_WRAPPER = `#!/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
while [ "$1" = "-e" ]; do export "$2" || exit 125; shift 2; done
exec "$@"
`

/** Parse a `\\wsl.localhost\<distro>\<path>` (or `\\wsl$\...`) Windows path. */
export function parseWslUnc(winPath) {
  const m = /^\\\\[?]?(wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/i.exec(winPath)
  if (!m) return null
  return { distro: m[2], linuxPath: '/' + m[3].replace(/\\/g, '/') }
}

export function linuxToUnc(distro, linuxPath) {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

/** Binaries on a Windows drive are interop, not Linux: never execute them. */
export function isInteropBinary(p) {
  return /^\/mnt\/[a-z]\//i.test(p)
}

/**
 * Keep the distribution's login PATH but drop every `/mnt/*` entry. The login
 * PATH is what makes user toolchains (`~/.local/bin`, nvm, cargo, …) visible;
 * dropping `/mnt` is what keeps Windows interop binaries unreachable.
 */
export function cleanLoginPath(raw) {
  // A login profile may print a banner; the PATH itself is the last line.
  const line = String(raw ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  const entries = line
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !/^\/mnt(\/|$)/i.test(entry))
  for (const dir of ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']) {
    if (!entries.includes(dir)) entries.push(dir)
  }
  return [...new Set(entries)].join(':') || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
}

export class WslBroker extends EventEmitter {
  #distro
  #user
  #idleMs
  #helperSource
  #child = null
  #state = 'detached'
  #buf = ''
  #seq = 0
  #pending = new Map()
  #connecting = null
  #retains = new Map()
  #idleTimer = null
  #nodePath = null
  #helperPath = null
  #cleanPath = null
  #lastError = null
  #retried = false
  #forceProbe = false
  #hello = null

  constructor({ distro, user = '', idleMs = 15 * 60_000, helperSource }) {
    super()
    this.#distro = distro
    this.#user = user
    this.#idleMs = idleMs
    this.#helperSource = helperSource
  }

  /** Apply a new idle timeout to an already-created broker. */
  setIdleMs(ms) {
    const n = Number(ms)
    if (!Number.isFinite(n) || n < 0) return
    this.#idleMs = n
    this.#armIdleIfIdle()
  }

  get state() { return this.#state }
  get hello() { return this.#hello }
  get refcount() { return [...this.#retains.values()].reduce((a, b) => a + b, 0) }
  /**
   * The distribution's login-shell PATH without `/mnt/*` entries. Tools use it
   * so a user-space toolchain (`~/.local/bin`, cargo, …) stays reachable while
   * Windows interop binaries stay unreachable. Resolved on connect.
   */
  get cleanPath() { return this.#cleanPath }
  get info() {
    return { distro: this.#distro, user: this.#user, state: this.#state, refcount: this.refcount, lastError: this.#lastError }
  }

  #setState(next, detail) {
    if (this.#state === next) return
    this.#state = next
    this.emit('state', { ...this.info, detail })
  }

  /** Park a reference so the idle timer cannot fire while work is in flight. */
  retain(reason) {
    this.#retains.set(reason, (this.#retains.get(reason) ?? 0) + 1)
    this.#disarmIdle()
    return () => this.release(reason)
  }

  release(reason) {
    const n = (this.#retains.get(reason) ?? 0) - 1
    if (n <= 0) this.#retains.delete(reason)
    else this.#retains.set(reason, n)
    this.#armIdleIfIdle()
  }

  #disarmIdle() {
    if (this.#idleTimer) { clearTimeout(this.#idleTimer); this.#idleTimer = null }
  }

  #armIdleIfIdle() {
    this.#disarmIdle()
    if (this.#idleMs <= 0 || this.#state !== 'ready' || this.refcount > 0) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null
      this.disconnect('idle').catch(() => {})
    }, this.#idleMs)
    this.#idleTimer.unref?.()
  }

  /** Idempotent, single-flight connect. */
  async connect() {
    if (this.#state === 'ready') return this.info
    if (this.#connecting) return this.#connecting
    this.#connecting = this.#doConnect().finally(() => { this.#connecting = null })
    return this.#connecting
  }

  async #doConnect() {
    this.#setState('starting')
    this.#lastError = null
    try {
      await this.#resolveCleanPath()
      const { node, helper } = await this.#ensureHelper()
      const hello = await this.#spawnHelper(node, helper)
      this.#hello = hello
      this.#setState('ready', hello)
      this.#armIdleIfIdle()
      return this.info
    } catch (error) {
      // A stale cache entry (distro reinstall, nvm switch) must self-heal once
      // with a real probe before the error reaches the caller.
      if (!this.#forceProbe && this.#readCache(this.#hashOfSource())) {
        this.#forceProbe = true
        this.#nodePath = null
        this.#helperPath = null
        return this.#doConnect()
      }
      this.#lastError = error.message
      this.#setState('error', { message: error.message })
      throw error
    }
  }

  #spawnHelper(node, helper) {
    return new Promise((resolve, reject) => {
      const args = [...this.#distroArgs(), ...this.#userArgs()]
      args.push('--', node, helper)
      const child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.#child = child
      let settled = false
      const fail = (err) => { if (!settled) { settled = true; reject(err) } }
      const timer = setTimeout(() => fail(new Error('helper handshake timed out after 15s')), 15_000)
      child.on('error', fail)
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        this.#onExit(code, signal)
        if (!settled) fail(new Error(`helper exited before handshake (code=${code} signal=${signal})`))
      })
      child.stdout.on('data', (d) => { this.#buf += d.toString('utf8'); this.#drain() })
      child.stderr.on('data', (d) => this.emit('stderr', d.toString('utf8')))
      child.stdin.on('error', () => {})
      this.once('hello', (h) => {
        clearTimeout(timer)
        settled = true
        resolve(h)
      })
    })
  }

  #onExit(code, signal) {
    const hadChild = this.#child !== null
    this.#child = null
    if (!hadChild) return
    for (const [, p] of this.#pending) p.reject(new Error(`WSL helper exited (code=${code} signal=${signal})`))
    this.#pending.clear()
    this.#hello = null
    if (this.#state === 'stopping' || this.#state === 'detached') return
    this.#lastError = `helper exited unexpectedly (code=${code} signal=${signal})`
    this.#setState('error', { message: this.#lastError })
    if (this.refcount > 0 && !this.#retried) {
      this.#retried = true
      setTimeout(() => { this.#retried = false; this.connect().catch(() => {}) }, 500).unref?.()
    }
  }

  #drain() {
    let i
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, i)
      this.#buf = this.#buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.event === 'hello') { this.emit('hello', msg.result); continue }
      const p = this.#pending.get(msg.id)
      if (!p) continue
      this.#pending.delete(msg.id)
      msg.error ? p.reject(Object.assign(new Error(msg.error.message ?? String(msg.error)), msg.error)) : p.resolve(msg.result)
    }
  }

  async call(op, args = {}, { signal } = {}) {
    await this.connect()
    if (signal?.aborted) throw new Error('aborted')
    this.#disarmIdle()
    try {
      return await this.#roundTrip(op, args, signal)
    } finally {
      this.#armIdleIfIdle()
    }
  }

  #roundTrip(op, args, signal) {
    return new Promise((resolve, reject) => {
      const id = ++this.#seq
      const onAbort = () => { this.#pending.delete(id); reject(new Error('aborted')) }
      this.#pending.set(id, {
        resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v) },
        reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e) },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.#child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n')
      } catch (error) {
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  async #resolveCleanPath() {
    if (this.#cleanPath !== null) return
    let raw = ''
    try {
      // `printenv` avoids `$` in wsl.exe's argv (it pre-expands `$VAR`).
      raw = await this.#wsl('printenv PATH')
    } catch {}
    this.#cleanPath = cleanLoginPath(raw)
  }

  async #ensureHelper() {
    if (this.#nodePath && this.#helperPath) return { node: this.#nodePath, helper: this.#helperPath }
    const hash = this.#hashOfSource()
    if (!this.#forceProbe) {
      const cached = this.#readCache(hash)
      if (cached) {
        this.#nodePath = cached.node
        this.#helperPath = cached.helper
        return { node: cached.node, helper: cached.helper }
      }
    }
    this.#forceProbe = false
    const node = await this.#wsl('command -v node')
    if (!node) throw new Error('WSL 发行版里没有 node（或只有 Windows 的 node.exe）。请安装 Node.js 22+，或等待 python3 兜底实现。')
    if (isInteropBinary(node)) throw new Error(`node 解析到了 Windows 的二进制（${node}），拒绝使用`)
    // Bootstrap through stdin: no /mnt, no package manager, no shared folder.
    const helper = `$HOME/.dsh-wsl/broker-${hash}.mjs`
    const present = await this.#wsl(`test -f ${helper} && echo yes`)
    if (present !== 'yes') {
      await this.#wslPipe(`mkdir -p $HOME/.dsh-wsl && cat > ${helper}`, this.#helperSource)
    }
    this.#nodePath = node
    this.#helperPath = helper
    this.#writeCache({ node, helper, hash })
    return { node, helper }
  }

  #distroArgs() { return this.#distro ? ['-d', this.#distro] : [] }
  #userArgs() { return this.#user ? ['-u', this.#user] : [] }

  #cacheFile() {
    return join(homedir(), '.dsh', 'wsl-broker-cache.json')
  }

  #hashOfSource() {
    return createHash('sha256').update(`v${HELPER_VERSION}\n` + this.#helperSource).digest('hex').slice(0, 16)
  }

  #readCache(hash) {
    try {
      const all = JSON.parse(readFileSync(this.#cacheFile(), 'utf8'))
      const entry = all[`${this.#distro}|${this.#user}`]
      if (entry?.v === HELPER_VERSION && entry.h === hash && entry.node && entry.helper) return entry
    } catch {}
    return null
  }

  #writeCache({ node, helper, hash }) {
    try {
      const file = this.#cacheFile()
      mkdirSync(join(homedir(), '.dsh'), { recursive: true })
      let all = {}
      try { all = JSON.parse(readFileSync(file, 'utf8')) } catch {}
      all[`${this.#distro}|${this.#user}`] = { v: HELPER_VERSION, h: hash, node, helper, at: new Date().toISOString() }
      writeFileSync(file, JSON.stringify(all, null, 2))
    } catch {}
  }

  #wsl(script) {
    return new Promise((resolve, reject) => {
      const args = [...this.#distroArgs(), ...this.#userArgs()]
      args.push('--', 'bash', '-lc', script)
      const child = spawn('wsl.exe', args, { windowsHide: true })
      let out = ''
      child.stdout.on('data', (d) => (out += d.toString('utf8')))
      child.on('error', reject)
      child.on('close', () => resolve(out.trim()))
    })
  }

  #wslPipe(script, input) {
    return new Promise((resolve, reject) => {
      const args = [...this.#distroArgs(), ...this.#userArgs()]
      args.push('--', 'bash', '-lc', script)
      const child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
      let err = ''
      child.stderr.on('data', (d) => (err += d.toString('utf8')))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`bootstrap failed (${code}): ${err}`))))
      child.stdin.end(input)
    })
  }

  async disconnect(reason = 'explicit') {
    if (this.#state === 'detached' || this.#state === 'stopping') return
    this.#setState('stopping', reason)
    this.#disarmIdle()
    const child = this.#child
    if (child) {
      try { child.stdin.write(JSON.stringify({ id: ++this.#seq, op: 'shutdown' }) + '\n') } catch {}
      await new Promise((r) => setTimeout(r, 80))
      try { child.kill() } catch {}
    }
    this.#child = null
    this.#hello = null
    this.#setState('detached', reason)
  }
}
