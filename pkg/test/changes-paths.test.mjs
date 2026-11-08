// Diff display-path translation for WSL sessions; Host open coordinates stay.
// Run: node test/changes-paths.test.mjs
import { installWorkspaceChangesPaths, mapDisplayPath } from '../src/changes-paths.mjs'

let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

check('maps a WSL UNC display path', mapDisplayPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\a.ts'), '/home/u/a.ts')
check('maps a wsl$ display path', mapDisplayPath('\\\\wsl$\\Ubuntu\\srv\\a.ts'), '/srv/a.ts')
check('leaves a relative path', mapDisplayPath('src/a.ts'), 'src/a.ts')
check('leaves a Windows path', mapDisplayPath('C:\\Users\\u\\a.ts'), 'C:\\Users\\u\\a.ts')

const summaryValue = {
  turn: 1,
  cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\u',
  files: [
    { path: 'src/a.ts', display: 'src/a.ts', added: 1, deleted: 0 },
    { path: '\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\outside.ts', display: '\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\outside.ts', added: 1, deleted: 0 },
  ],
  total: 2,
  added: 2,
  deleted: 0,
}
const diffValue = {
  kind: 'text',
  path: 'src/a.ts',
  display: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\src\\a.ts',
  before: false,
  after: true,
  hunks: [],
  coarse: true,
}

const raw = {
  summary: () => summaryValue,
  diff: async () => diffValue,
}
const agents = {
  s1: { session: { id: 's1' } },
  s2: { session: { id: 's2' } },
}
const ctx = {
  get: (name) => name === 'workspaceChanges' ? raw
    : name === 'agents' ? { get: (id) => agents[id] }
    : name === 'agentPresets' ? { presetForSession: (session) => session.id === 's1' ? 'wsl' : 'ptc' }
    : undefined,
  on: () => {},
}

const patch = installWorkspaceChangesPaths(ctx)
check('changes patch installed', patch.installed, true)
check('summary display mapped', raw.summary('s1', 1).files.map((f) => f.display), ['src/a.ts', '/tmp/outside.ts'])
check('summary host path kept for open', raw.summary('s1', 1).files[1].path, '\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\outside.ts')
check('summary cwd kept for open', raw.summary('s1', 1).cwd, summaryValue.cwd)
check('non-WSL summary unchanged', raw.summary('s2', 1), summaryValue)
check('diff display mapped', (await raw.diff('s1', 1, 0, new AbortController().signal)).display, '/home/u/src/a.ts')
check('non-WSL diff unchanged', await raw.diff('s2', 1, 0, new AbortController().signal), diffValue)
patch.dispose()
check('dispose restores summary', raw.summary('s1', 1), summaryValue)
check('dispose restores diff display', (await raw.diff('s1', 1, 0, new AbortController().signal)).display, diffValue.display)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
