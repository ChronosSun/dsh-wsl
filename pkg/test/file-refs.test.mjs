// `@` discovery from the WSL tree, plus the Host-service patch.
// Run: node test/file-refs.test.mjs
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { WslBroker } from '../src/broker.mjs'
import { candidatesFromEntries, installWslFileReferences } from '../src/file-references.mjs'

const DISTRO = 'Ubuntu-24.04'
const USER = 'chronos'
const ROOT = '/tmp/dsh-refs-test'
const UNC = '\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\dsh-refs-test'
const helperSource = readFileSync(new URL('../src/helper.mjs', import.meta.url), 'utf8')

let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

// --- pure ranking -----------------------------------------------------------
const entries = [
  { path: 'src', kind: 'directory' },
  { path: 'src/a.ts', kind: 'file' },
  { path: 'src/nested', kind: 'directory' },
  { path: 'src/nested/b.ts', kind: 'file' },
  { path: 'README.md', kind: 'file' },
  { path: '.hidden', kind: 'file' },
  { path: 'build', kind: 'directory' },
  { path: 'build/out.ts', kind: 'file' },
]
check('empty query lists root entries', candidatesFromEntries(entries, '').map((c) => c.path), ['build', 'src', '.hidden', 'README.md'])
check('directory query lists direct children', candidatesFromEntries(entries, 'src/').map((c) => c.path), ['src/nested', 'src/a.ts'])
check('bare query ranks files', candidatesFromEntries(entries, 'a').map((c) => c.path), ['src/a.ts', 'README.md'])
check('excluded dirs are not ranked', candidatesFromEntries(entries, 'out').map((c) => c.path), [])
check('dot files need a dot query', candidatesFromEntries(entries, 'hid').map((c) => c.path), [])
check('dot query sees dot files', candidatesFromEntries(entries, '.hid').map((c) => c.path), ['.hidden'])

// --- real tree RPC ----------------------------------------------------------
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
  `mkdir -p ${ROOT}/src ${ROOT}/build ${ROOT}/node_modules`,
  `cd ${ROOT} && git init -q`,
  `printf '%s\\n' 'build/' 'node_modules/' > .gitignore`,
  `printf '%s\\n' 'export const a = 1' > src/a.ts`,
  `printf '%s\\n' 'export const nested = 1' > src/nested.ts`,
  `printf '%s\\n' 'ignored' > build/b.ts`,
  `printf '%s\\n' 'dep' > node_modules/n.ts`,
].join('\n'))
if (setup.code !== 0) {
  console.log('setup failed', setup)
  process.exit(1)
}

const broker = new WslBroker({ distro: DISTRO, user: USER, helperSource })
await broker.connect()
try {
  const tree = await broker.call('tree', { path: ROOT, max: 100 })
  const paths = tree.entries.map((entry) => entry.path)
  check('tree includes tracked source', paths.includes('src/a.ts'), true)
  check('tree derives the directory', paths.includes('src'), true)
  check('tree excludes ignored build output', paths.includes('build/b.ts'), false)
  check('tree excludes node_modules', paths.includes('node_modules/n.ts'), false)

  let originalCalls = 0
  const raw = {
    async list() { originalCalls += 1; return [{ path: 'HOST', kind: 'file' }] },
  }
  const agent = { session: { id: 's1' } }
  const ptc = { session: { id: 's2' } }
  const presets = { presetForSession: (session) => session.id === 's1' ? 'wsl' : 'ptc' }
  const workingDirectory = { get: () => UNC }
  const ctx = {
    get: (name) => name === 'agentPresets' ? presets
      : name === 'workingDirectory' ? workingDirectory
      : name === 'fileReferences' ? raw
      : undefined,
    on: () => {},
  }
  const patch = installWslFileReferences(ctx)
  check('fileReferences patch installed', patch.installed, true)
  const wslCandidates = await raw.list(agent, 'a')
  check('WSL agent gets Linux candidates', wslCandidates.map((c) => c.path), ['src/a.ts'])
  check('WSL query did not call the Host provider', originalCalls, 0)
  const hostCandidates = await raw.list(ptc, 'a')
  check('non-WSL agent keeps the Host provider', hostCandidates, [{ path: 'HOST', kind: 'file' }])
  check('non-WSL query called the Host provider', originalCalls, 1)
  patch.dispose()
  await raw.list(agent, 'a')
  check('dispose restores the Host provider', originalCalls, 2)
} finally {
  await broker.disconnect('test')
  await wsl(`rm -rf ${ROOT}`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
