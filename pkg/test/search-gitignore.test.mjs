// glob/grep in a Git worktree must respect .gitignore (via git ls-files).
// Run: node test/search-gitignore.test.mjs
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { WslBroker } from '../src/broker.mjs'

const DISTRO = 'Ubuntu-24.04'
const USER = 'chronos'
const ROOT = '/tmp/dsh-gitsearch-test'
const PLAIN = '/tmp/dsh-nogit-test'
const helperSource = readFileSync(new URL('../src/helper.mjs', import.meta.url), 'utf8')

let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

function wsl(script) {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-d', DISTRO, '-u', USER, '--', 'bash', '-lc', script], { windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
  })
}

const setup = await wsl(
  `rm -rf ${ROOT} ${PLAIN}; mkdir -p ${ROOT}/src ${ROOT}/build ${ROOT}/node_modules ${PLAIN}; ` +
  `cd ${ROOT} && git init -q && printf '%s\\n' 'build/' 'node_modules/' > .gitignore && ` +
  `printf 'export const a = 1\\n' > src/a.ts && printf 'artifact here\\n' > build/b.ts && ` +
  `printf 'dependency\\n' > node_modules/n.ts && printf 'plain\\n' > src/keep.md; ` +
  `printf 'not a repo\\n' > ${PLAIN}/x.ts`,
)
if (setup.code !== 0) {
  console.log('setup failed:', setup)
  process.exit(1)
}

const broker = new WslBroker({ distro: DISTRO, user: USER, helperSource })
await broker.connect()
try {
  const glob = await broker.call('glob', { path: ROOT, pattern: '*.ts', max: 100 })
  check('glob respects .gitignore', glob.paths.map((p) => p.slice(ROOT.length + 1)), ['src/a.ts'])
  check('glob does not return node_modules', glob.paths.some((p) => p.includes('node_modules')), false)

  const ignored = await broker.call('grep', { path: ROOT, pattern: 'artifact', max: 100 })
  check('grep skips ignored build output', ignored.total, 0)

  const kept = await broker.call('grep', { path: ROOT, pattern: 'export', max: 100 })
  check('grep finds tracked source', kept.files.map((f) => f.path.slice(ROOT.length + 1)), ['src/a.ts'])

  const plain = await broker.call('glob', { path: PLAIN, pattern: '*.ts', max: 100 })
  check('non-Git root falls back to walk', plain.paths, [`${PLAIN}/x.ts`])
} finally {
  await broker.disconnect('test')
  await wsl(`rm -rf ${ROOT} ${PLAIN}`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
