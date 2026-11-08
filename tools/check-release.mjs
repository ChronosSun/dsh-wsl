#!/usr/bin/env node
// Release gate: package/client id, cordis subpaths and market metadata must
// agree before publishing. Run from pkg/ with `npm run check`.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkgDir = join(root, 'pkg')
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const client = readFileSync(join(pkgDir, 'client.js'), 'utf8')
const patch = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8')
const market = JSON.parse(readFileSync(join(root, 'market', 'index.json'), 'utf8'))

const errors = []
const ok = (condition, message) => { if (!condition) errors.push(message) }

const id = /id:\s*'([^']+)'/.exec(client.slice(0, 200))?.[1]
ok(id === pkg.name, `client id ${JSON.stringify(id)} != package name ${JSON.stringify(pkg.name)}`)
ok((client.match(/__ModuleLoader__\.load/g) ?? []).length === 1, 'client.js must contain exactly one ModuleLoader.load')

for (const match of patch.matchAll(/name:\s*'(@chronosun\/dsh-wsl\/[^']+)'/g)) {
  const subpath = match[1].slice(pkg.name.length + 1)
  ok(Boolean(pkg.exports?.[`./${subpath}`]), `cordis.patch subpath /${subpath} has no package export`)
}

for (const file of ['path-tool.mjs', 'project-tool.mjs', 'bootstrap-tool.mjs', 'terminal-tool.mjs']) {
  ok(pkg.files?.includes(file), `package files missing ${file}`)
}

const entry = market.plugins?.find((plugin) => plugin.name === pkg.name)
ok(Boolean(entry), 'market index does not contain this package')
ok(entry?.versions?.[0]?.version === pkg.version, `market version ${entry?.versions?.[0]?.version} != package ${pkg.version}`)
ok(typeof entry?.versions?.[0]?.publishTimestamp === 'number', 'market publishTimestamp must be a number')

if (errors.length) {
  console.error(`release check failed (${errors.length})`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}
console.log(`release check: ok (${pkg.name}@${pkg.version}, ${market.plugins.length} market entries)`)
