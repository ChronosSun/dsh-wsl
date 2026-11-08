// `ctx.fs` for the WSL world. Mirrors world.js: the host's FileSystem base is
// used when resolvable, otherwise the service is registered through Context.
// Delegation (not inheritance) keeps the factory free of host imports and
// avoids `#private` brand checks through Cordis' service proxy.
import { registry } from './src/registry.mjs'
import { createWslFileSystem } from './src/fs.mjs'

let Base = null
try {
  const mod = await import('@deepseek-ai/dsh-fs')
  Base = mod.FileSystem ?? mod.default ?? null
} catch {
  Base = null
}

class ServiceShim {
  constructor(ctx) {
    this.ctx = ctx
    if (typeof ctx.set !== 'function') {
      throw new Error('fs-wsl: this Harness build exposes neither the FileSystem base class nor ctx.set')
    }
    ctx.provide?.('fs')
    ctx.set('fs', this)
  }
}

const Parent = Base ?? ServiceShim
const METHODS = [
  'resolve', 'processPath', 'processPathFromHostPath', 'fileUrl', 'contains', 'stat', 'lstat',
  'readText', 'streamText', 'readBytes', 'readByteRange', 'listDir', 'writeText', 'editText',
  'patchText', 'deleteFile', 'moveFile', 'watch',
]

export default class WslFileSystemService extends Parent {
  constructor(ctx, config = {}) {
    super(ctx)
    if (!this.ctx) this.ctx = ctx
    const user = config.user ?? ''
    // One provider for every distribution: each target carries its own, so a
    // workspace in another distro resolves through that distro's broker.
    this.impl = createWslFileSystem({
      brokerFor: (distro) => registry.get(distro ?? '', user),
      defaultDistro: config.distro ?? '',
      defaultCwd: config.defaultCwd ?? '/',
    })
  }
}

for (const method of METHODS) {
  Object.defineProperty(WslFileSystemService.prototype, method, {
    configurable: true,
    writable: true,
    value: function delegate(...args) {
      return this.impl[method](...args)
    },
  })
}
