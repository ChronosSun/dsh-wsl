// create_wsl_worktree: Linux git worktree creation without changing cwd.
// Run: node test/worktree.test.mjs
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { WslBroker } from '../src/broker.mjs'
import { apply } from '../worktree-tool-v2.mjs'

const DISTRO = 'Ubuntu-24.04'
const USER = 'chronos'
const ROOT = '/tmp/dsh-worktree-test'
const UNC = '\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\dsh-worktree-test'
const helperSource = readFileSync(new URL('../src/helper.mjs', import.meta.url), 'utf8')

let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

function wsl(script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-d', DISTRO, '-u', USER, '--', 'bash', '-c', `printf %s ${b64} | base64 -d | bash`], { windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
  })
}

const setup = await wsl([
  `rm -rf ${ROOT}`,
  `mkdir -p ${ROOT}`,
  `cd ${ROOT} && git init -q`,
  `git -c user.email=eval@example.invalid -c user.name=eval commit -q --allow-empty -m init`,
].join('\n'))
if (setup.code !== 0) {
  console.log('setup failed', setup)
  process.exit(1)
}

const broker = new WslBroker({ distro: DISTRO, user: USER, helperSource })
await broker.connect()
let tool
const ctx = {
  tools: { register: (definition) => { tool = definition; return () => {} } },
  get: (name) => name === 'workingDirectory' ? { get: () => UNC } : undefined,
}
const dispose = apply(ctx)
try {
  const result = await tool.execute({ name: 'e2e' }, { agent: { cwd: UNC } })
  check('worktree path', result.path, `${ROOT}/.agents/worktrees/e2e`)
  check('worktree branch', result.branch, 'dsh/e2e')
  check('worktree base is a commit', /^[0-9a-f]{40}$/.test(result.baseCommit), true)
  const listed = await broker.call('exec', { argv: ['git', '-C', ROOT, 'worktree', 'list', '--porcelain'], cwd: ROOT })
  check('git registered the worktree', listed.out.includes(`${ROOT}/.agents/worktrees/e2e`), true)
  const status = await broker.call('exec', { argv: ['git', '-C', ROOT, 'status', '--short'], cwd: ROOT })
  check('worktree excluded from parent status', status.out.split(/\r?\n/).some((line) => line.includes('.agents/')), false)

  // The tool context can report `/`; the Session header must win.
  const second = await tool.execute({ name: 'e2e-header' }, { agent: { cwd: '/', session: { id: 'test', header: { cwd: UNC } } } })
  check('session header fallback', second.path, `${ROOT}/.agents/worktrees/e2e-header`)
} finally {
  dispose()
  await broker.disconnect('test')
  await wsl([
    `git -C ${ROOT} worktree remove --force ${ROOT}/.agents/worktrees/e2e 2>/dev/null || true`,
    `rm -rf ${ROOT}`,
  ].join('\n'))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
