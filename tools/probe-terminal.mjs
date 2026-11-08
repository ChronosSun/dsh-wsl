// Probe the terminal launcher against a real WSL cwd and verify the user/PATH
// it hands the interactive shell. Run:
//   node tools/probe-terminal.mjs
//   PROBE_DISTRO=Ubuntu-26.04 PROBE_LINUX=/home/chronos node tools/probe-terminal.mjs
import { spawn } from 'node:child_process'

const LAUNCHER = new URL('../pkg/terminal-launcher.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const distro = process.env.PROBE_DISTRO ?? 'Ubuntu-24.04'
const linux = process.env.PROBE_LINUX ?? '/home/chronos/develop'
const cwd = `\\\\wsl.localhost\\${distro}${linux.replace(/\//g, '\\')}`

const child = spawn(process.execPath, [LAUNCHER], {
  cwd,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
let out = '', err = ''
child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
const timer = setTimeout(() => {
  try { child.stdin.write("printf 'CLEANUSER=%s\\nCLEANPATH=%s\\n' \"$(id -un)\" \"$PATH\"; exit\n") } catch {}
}, 2500)
child.on('close', (code) => {
  clearTimeout(timer)
  const user = /CLEANUSER=([^\r\n]*)/.exec(out)?.[1] ?? ''
  const cleanPath = /CLEANPATH=([^\r\n]*)/.exec(out)?.[1] ?? ''
  const hasMnt = /(^|:)\/mnt(\/|$)/.test(cleanPath)
  console.log(JSON.stringify({ distro, code, user, cleanPath, hasMnt, err: err.slice(0, 400) }, null, 2))
  process.exitCode = code === 0 && user && user !== 'root' && !hasMnt ? 0 : 1
})
