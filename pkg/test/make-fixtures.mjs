// Create search fixtures through the broker (the same path the plugin uses).
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WslBroker } from '../src/broker.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const helperSource = await readFile(join(here, '..', 'src', 'helper.mjs'), 'utf8')
const DISTRO = process.env.DSH_WSL_PROBE_DISTRO ?? 'Ubuntu-24.04'
const ROOT = '/home/chronos/deepseek'

const broker = new WslBroker({ distro: DISTRO, idleMs: 0, helperSource })
await broker.connect()

const files = {
  [`${ROOT}/sample.ts`]: '// TODO: wire the search tool\nexport const a = 1\n// TODO: second hit\n',
  [`${ROOT}/src/deep/nested.ts`]: 'export const nested = 2\n// TODO: nested file\n',
  [`${ROOT}/readme.md`]: '# readme\nTODO: not a ts file\n',
}

for (const [path, text] of Object.entries(files)) {
  await broker.call('write', { path, text })
  console.log(`wrote ${path}`)
}

const glob = await broker.call('glob', { path: ROOT, pattern: '**/*.ts' })
console.log('glob **/*.ts →', glob.paths.join(', '))

const hits = await broker.call('grep', { path: ROOT, pattern: 'TODO', include: '*.ts' })
console.log('grep TODO (include *.ts) →')
for (const file of hits.files) {
  for (const match of file.matches) console.log(`  ${file.path}:${match.lineNumber}: ${match.line}`)
}

await broker.disconnect('fixtures-done')
