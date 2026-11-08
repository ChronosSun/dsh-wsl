// One broker per (distro, user), shared by the world and the panel.
// ESM module cache makes this a process-wide singleton for every row of this
// package, so the panel observes the very connections sessions use.
import { readFileSync } from 'node:fs'
import { WslBroker } from './broker.mjs'

const helperSource = readFileSync(new URL('./helper.mjs', import.meta.url), 'utf8')

class WslRegistry {
  #brokers = new Map()
  #idleMinutes = 15

  set idleMinutes(minutes) {
    const n = Number(minutes)
    if (!Number.isFinite(n) || n < 0) return
    this.#idleMinutes = n
    for (const broker of this.#brokers.values()) broker.setIdleMs(n * 60_000)
  }

  get idleMinutes() { return this.#idleMinutes }

  key(distro, user) { return `${distro}|${user}` }

  get(distro = '', user = '') {
    const key = this.key(distro, user)
    let broker = this.#brokers.get(key)
    if (!broker) {
      broker = new WslBroker({ distro, user, idleMs: this.#idleMinutes * 60_000, helperSource })
      broker.on('state', (s) => this.#log(`[${key}] ${s.state}`))
      this.#brokers.set(key, broker)
    }
    return broker
  }

  peek(distro, user) { return this.#brokers.get(this.key(distro, user)) }

  list() {
    return [...this.#brokers.entries()].map(([key, broker]) => ({
      key,
      ...broker.info,
      hello: broker.hello
        ? { user: broker.hello.user, home: broker.hello.home, node: broker.hello.node, cwd: broker.hello.cwd }
        : undefined,
    }))
  }

  async disconnectAll() {
    for (const broker of this.#brokers.values()) await broker.disconnect('shutdown').catch(() => {})
  }

  #log(message) {
    try { process.stdout.write(`[dsh-wsl] ${message}\n`) } catch {}
  }
}

export const registry = new WslRegistry()
