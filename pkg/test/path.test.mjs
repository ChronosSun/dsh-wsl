// The login PATH minus /mnt, and the command path that uses it.
// Run: node test/path.test.mjs
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { WslBroker, cleanLoginPath } from '../src/broker.mjs'
import { buildArgv } from '../src/launch.mjs'

const DISTRO = 'Ubuntu-24.04'
const USER = 'chronos'
const helperSource = readFileSync(new URL('../src/helper.mjs', import.meta.url), 'utf8')

let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

// --- pure filtering ---------------------------------------------------------
{
  const cleaned = cleanLoginPath('/home/u/.local/bin:/mnt/c/Windows:/usr/bin:/mnt/d/x:/bin')
  check('keeps user toolchain dirs', cleaned.includes('/home/u/.local/bin'), true)
  check('drops /mnt entries', cleaned.includes('/mnt/'), false)
  check('keeps system dirs', cleaned.includes('/usr/bin'), true)
  check('deduplicates and appends essentials', cleanLoginPath('/usr/bin:/usr/bin'), '/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin')
  check('empty falls back to system dirs', cleanLoginPath('').includes('/usr/bin'), true)
}

// --- end-to-end against the distro -----------------------------------------
const broker = new WslBroker({ distro: DISTRO, user: USER, helperSource })
await broker.connect()
const loginPath = broker.cleanPath
console.log('login + cleanPath:', loginPath)
check('broker resolved a clean login PATH', typeof loginPath === 'string' && loginPath.includes('/home/chronos/.local/bin'), true)
check('broker clean PATH has no /mnt', loginPath.includes('/mnt/'), false)

const argv = buildArgv(
  { argv: ['bash', '-c', 'printenv PATH; command -v node; command -v npm'], env: {} },
  { distro: DISTRO, user: USER, cwd: '/home/chronos/develop', path: loginPath },
)
const result = await new Promise((resolve) => {
  const child = spawn('wsl.exe', argv, { windowsHide: true })
  let out = '', err = ''
  child.stdout.on('data', (d) => (out += d.toString('utf8')))
  child.stderr.on('data', (d) => (err += d.toString('utf8')))
  child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
})
console.log('probe:', JSON.stringify({ code: result.code, out: result.out.split('\n').slice(0, 4), err: result.err.slice(0, 200) }))
const lines = result.out.split('\n')
check('command sees the clean login PATH', lines[0], loginPath)
check('node resolves from the user toolchain', lines[1], '/home/chronos/.local/bin/node')
check('npm resolves from the user toolchain', lines[2], '/home/chronos/.local/bin/npm')
check('no /mnt in the command output', result.out.includes('/mnt/'), false)

await broker.disconnect('test')
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
