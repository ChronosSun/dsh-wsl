import assert from 'node:assert/strict'
import { installPresetRosterFilter } from '../src/preset-roster.mjs'

const ORIGINAL = Symbol.for('cordis.original')

class FakeRegistry {
  async list() {
    return [
      { id: 'standard', name: 'Standard' },
      { id: 'cordis', name: 'Creator' },
      { id: 'wsl', name: 'WSL' },
      { id: 'wsl-standard', name: 'Standard' },
      { id: 'wsl-cordis', name: 'Creator' },
      { id: 'wsl-ptc', name: 'PTC' },
      { id: 'wsl-minimal', name: 'Minimal' },
    ]
  }
  async remoteExportList() {
    return { presets: (await this.list()).map((row) => ({ ...row, isDefault: row.id === 'standard' })) }
  }
}

const raw = new FakeRegistry()
const proxy = new Proxy(raw, {
  get(target, prop, receiver) {
    if (prop === ORIGINAL) return target
    return Reflect.get(target, prop, receiver)
  },
})
const ctx = {
  get: (name) => name === 'agentPresets' ? proxy : undefined,
  on: () => {},
}

const patch = installPresetRosterFilter(ctx)
assert.equal(patch.installed, true)
assert.deepEqual((await raw.list()).map((row) => row.id), ['standard', 'cordis'])
assert.deepEqual((await raw.remoteExportList()).presets.map((row) => row.id), ['standard', 'cordis'])
patch.dispose()
assert.deepEqual((await raw.list()).map((row) => row.id), ['standard', 'cordis', 'wsl', 'wsl-standard', 'wsl-cordis', 'wsl-ptc', 'wsl-minimal'])

console.log('preset-roster: ok')
