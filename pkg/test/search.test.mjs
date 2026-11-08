// glob/grep helper ops — real distro, no external search binary.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WslBroker } from '../src/broker.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const helperSource = await readFile(join(here, '..', 'src', 'helper.mjs'), 'utf8')
const DISTRO = process.env.DSH_WSL_PROBE_DISTRO ?? 'Ubuntu-24.04'
const ROOT = '/home/chronos/dsh-wsl-m0/search-test'

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const broker = new WslBroker({ distro: DISTRO, idleMs: 0, helperSource })
await broker.connect()

await broker.call('exec', {
  argv: ['/bin/bash', '-c', [
    `rm -rf ${ROOT}`,
    `mkdir -p ${ROOT}/src/deep ${ROOT}/node_modules/pkg`,
    `printf 'alpha\\nTODO: first\\nomega\\n' > ${ROOT}/src/a.ts`,
    `printf 'beta\\n' > ${ROOT}/src/deep/b.ts`,
    `printf 'TODO: ignored\\n' > ${ROOT}/node_modules/pkg/c.ts`,
    `printf 'gamma\\n' > ${ROOT}/readme.md`,
  ].join(' && ')],
})

// glob
{
  const all = await broker.call('glob', { path: ROOT, pattern: '**/*.ts' })
  const names = all.paths.map((p) => p.replace(ROOT + '/', ''))
  ok(names.includes('src/a.ts') && names.includes('src/deep/b.ts'), 'glob finds nested files', names.join(','))
  ok(!names.some((n) => n.startsWith('node_modules')), 'glob prunes node_modules')
  ok(!names.includes('readme.md'), 'glob honours the pattern')

  const base = await broker.call('glob', { path: ROOT, pattern: '*.md' })
  ok(base.paths.some((p) => p.endsWith('readme.md')), 'pattern without / matches basenames at any depth')

  const capped = await broker.call('glob', { path: ROOT, pattern: '**/*.ts', max: 1 })
  ok(capped.paths.length === 1 && capped.truncated === true, 'glob honours max and reports truncation')
}

// grep
{
  const result = await broker.call('grep', { path: ROOT, pattern: 'TODO' })
  const files = result.files.map((f) => f.path.replace(ROOT + '/', ''))
  ok(files.includes('src/a.ts'), 'grep finds the matching file', files.join(','))
  ok(!files.some((f) => f.startsWith('node_modules')), 'grep prunes node_modules')
  const hit = result.files.find((f) => f.path.endsWith('a.ts')).matches[0]
  ok(hit.lineNumber === 2 && hit.line.includes('TODO: first'), 'grep reports line numbers and text', JSON.stringify(hit))

  const filtered = await broker.call('grep', { path: ROOT, pattern: 'beta', include: '*.ts' })
  ok(filtered.files.length === 1 && filtered.files[0].path.endsWith('b.ts'), 'include filter limits files')

  let bad = ''
  try { await broker.call('grep', { path: ROOT, pattern: '(' }) } catch (error) { bad = error.code }
  ok(bad === 'FS_BAD_PATTERN', 'invalid regex reports FS_BAD_PATTERN', bad)
}

await broker.call('exec', { argv: ['/bin/bash', '-c', `rm -rf ${ROOT}`] })
await broker.disconnect('test-done')
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
