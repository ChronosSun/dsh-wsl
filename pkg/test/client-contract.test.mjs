import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const client = readFileSync(join(root, 'client.js'), 'utf8')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

// DSH's client-modules registry keys a bundle by its package name. A mismatch
// produced the 1.7.1 boot crash ("loaded without registering"), so make it a
// test rather than a release-time surprise.
const id = /id:\s*'([^']+)'/.exec(client.slice(0, 200))?.[1]
assert.equal(id, pkg.name, 'client bundle id must equal package name')
assert.equal((client.match(/__ModuleLoader__\.load/g) ?? []).length, 1, 'client bundle must load exactly once')

for (const match of patch.matchAll(/name:\s*'(@chronosun\/dsh-wsl\/[^']+)'/g)) {
  const subpath = match[1].slice(pkg.name.length + 1)
  assert.ok(pkg.exports?.[`./${subpath}`], `cordis.patch exports ./${subpath}`)
}

for (const file of ['path-tool.mjs', 'project-tool.mjs', 'bootstrap-tool.mjs', 'terminal-tool.mjs']) {
  assert.ok(pkg.files?.includes(file), `package files include ${file}`)
}

const market = JSON.parse(readFileSync(join(root, '..', 'market', 'index.json'), 'utf8'))
const entry = market.plugins?.find((plugin) => plugin.name === pkg.name)
assert.ok(entry, 'market index contains this package')
assert.equal(entry.versions?.[0]?.version, pkg.version, 'market version equals package version')
assert.equal(typeof entry.versions?.[0]?.publishTimestamp, 'number', 'market timestamp is a number')

console.log('client-contract: ok')
