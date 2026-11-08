// WSL git snapshots and per-file diffs used by the future diff recorder.
// Run: node test/git-diff.test.mjs
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { WslBroker } from '../src/broker.mjs'

const DISTRO = 'Ubuntu-24.04'
const USER = 'chronos'
const ROOT = '/tmp/dsh-gitdiff-test'
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
  `printf '%s\\n' one > a.txt`,
  `git add a.txt`,
  `git -c user.email=eval@example.invalid -c user.name=eval commit -q -m init`,
].join('\n'))
if (setup.code !== 0) {
  console.log('setup failed', setup)
  process.exit(1)
}

const broker = new WslBroker({ distro: DISTRO, user: USER, helperSource })
await broker.connect()
try {
  const before = await broker.call('gitSnapshot', { cwd: ROOT })
  check('before snapshot has a tree', typeof before.tree === 'string' && before.tree.length > 0, true)

  await broker.call('write', { path: `${ROOT}/a.txt`, text: 'one\ntwo\n' })
  await broker.call('write', { path: `${ROOT}/b.txt`, text: 'new\n' })
  // A retained checkout under .agents must not become a parent gitlink.
  await broker.call('exec', {
    argv: ['git', '-C', ROOT, 'worktree', 'add', '-b', 'test-wt', `${ROOT}/.agents/worktrees/test-wt`, 'HEAD'],
    cwd: ROOT,
  })
  const after = await broker.call('gitSnapshot', { cwd: ROOT })
  check('after snapshot differs', after.tree === before.tree, false)

  const summary = await broker.call('gitSummary', { cwd: ROOT, before: before.tree, after: after.tree })
  const paths = summary.files.map((file) => file.path).sort()
  check('summary lists both files', paths, ['a.txt', 'b.txt'])
  check('summary excludes the retained checkout', summary.files.some((file) => file.path.startsWith('.agents/')), false)
  check('summary counts the added line', summary.files.find((file) => file.path === 'a.txt')?.added, 1)
  check('summary counts the new file', summary.files.find((file) => file.path === 'b.txt')?.added, 1)

  const diff = await broker.call('gitDiffFile', { cwd: ROOT, before: before.tree, after: after.tree, path: 'a.txt' })
  check('diff kind', diff.kind, 'text')
  check('diff before exists', diff.before, true)
  check('diff after exists', diff.after, true)
  check('diff has hunks', diff.hunks.length > 0, true)
  check('diff contains the added line', diff.hunks.some((hunk) => hunk.lines.includes('+two')), true)
} finally {
  await broker.disconnect('test')
  await wsl(`rm -rf ${ROOT}`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
