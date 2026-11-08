// WSL diff recorder: event flow, summary, per-file diff, dispose.
// Run: node test/wsl-diff.test.mjs
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { WslBroker } from '../src/broker.mjs'
import { installWslDiff } from '../src/wsl-diff-v2.mjs'

const DISTRO = 'Ubuntu-24.04'
const USER = 'chronos'
const ROOT = '/tmp/dsh-wsl-diff-test'
const UNC = '\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\dsh-wsl-diff-test'
const helperSource = readFileSync(new URL('../src/helper.mjs', import.meta.url), 'utf8')

let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  `printf '%s\\n' one > a.txt`,
].join('\n'))
if (setup.code !== 0) {
  console.log('setup failed', setup)
  process.exit(1)
}

const broker = new WslBroker({ distro: DISTRO, user: USER, helperSource })
await broker.connect()

const listeners = {}
const raw = {
  summary() { return undefined },
  diff() { return undefined },
}
const session = { id: 'session-diff-test', header: { cwd: UNC } }
const ctx = {
  get: (name) => name === 'workspaceChanges' ? raw
    : name === 'agentPresets' ? { presetForSession: () => 'wsl' }
    : undefined,
  on: (name, fn) => { listeners[name] = fn },
}

const patch = installWslDiff(ctx)
check('wsl diff installed', patch.installed, true)

try {
  listeners['session/event'](session, { type: 'turn/start', data: { turn: 1 } })
  await sleep(1500)
  await broker.call('write', { path: `${ROOT}/a.txt`, text: 'one\ntwo\n' })
  await broker.call('write', { path: `${ROOT}/b.txt`, text: 'new\n' })
  listeners['session/event'](session, { type: 'turn/end', data: { turn: 1 } })
  await sleep(3000)
  listeners['session/event'](session, { type: 'workspace/changes', seq: 42, data: { turn: 1 } })

  const summary = raw.summary(session.id, 42)
  check('summary has both files', summary?.files?.map((f) => f.path).sort(), ['a.txt', 'b.txt'])
  check('summary cwd stays UNC for open', summary.cwd, UNC)
  check('summary is relative', summary.files.every((f) => !f.path.startsWith('\\\\')), true)
  check('summary added line', summary.files.find((f) => f.path === 'a.txt')?.added, 1)

  const diff = await raw.diff(session.id, 42, summary.files.findIndex((f) => f.path === 'a.txt'), new AbortController().signal)
  check('diff kind', diff?.kind, 'text')
  check('diff hunk has +two', diff?.hunks?.some((hunk) => hunk.lines.includes('+two')), true)

  check('unknown seq falls back', raw.summary(session.id, 99), undefined)
} finally {
  patch.dispose()
  check('dispose restores summary', raw.summary(session.id, 42), undefined)
  await broker.disconnect('test')
  await wsl(`rm -rf ${ROOT}`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
