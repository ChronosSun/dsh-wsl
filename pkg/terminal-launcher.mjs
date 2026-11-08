// Sidebar-terminal launcher.
//
// `terminal-controller` is a Host service: it spawns the terminal process
// itself, outside any agent preset, so a WSL preset cannot influence it. This
// launcher is the supported way in: point the controller's `shell.path` at node
// and this file, and pick the shell from the working directory the controller
// hands us. Windows workspaces keep their normal shell — nothing changes there.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { userFor } from './src/settings.mjs'
import { userFromLinuxPath } from './src/path-user.mjs'

const cwd = process.cwd()
const unc = /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/i.exec(cwd)

// Terminals open rarely; one line here makes "it opened cmd again" debuggable.
const LOG = join(tmpdir(), 'dsh-wsl-terminal.log')
try { appendFileSync(LOG, `${new Date().toISOString()} cwd=${JSON.stringify(cwd)} branch=${unc ? 'wsl:' + unc[1] : 'windows'}\n`) } catch {}

function run(file, args, options) {
  const child = spawn(file, args, { stdio: 'inherit', windowsHide: false, ...options })
  child.on('error', (error) => {
    process.stderr.write(`terminal-launcher: ${error.message}\r\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

if (unc) {
  const distro = unc[1]
  const linuxPath = '/' + unc[2].replace(/\\/g, '/')
  const user = userFromLinuxPath(linuxPath) || userFor(distro)
  const userArgs = user ? ['-u', user] : []
  // Match the Agent's clean environment: keep the login PATH but drop every
  // `/mnt/*` interop entry. A probe failure falls back to the normal login shell.
  let cleanPath = ''
  try {
    const login = execFileSync('wsl.exe', ['-d', distro, ...userArgs, '-e', 'bash', '-lc', 'printenv PATH'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    }).trim()
    cleanPath = login.split(':').filter((entry) => entry && !/^\/mnt(\/|$)/i.test(entry)).join(':')
    appendFileSync(LOG, `${new Date().toISOString()} user=${user || '(default)'} cleanPath mnt=${login.split(':').filter((entry) => /^\/mnt(\/|$)/i.test(entry)).length}\n`)
  } catch {}
  // Do not hand wsl.exe a UNC cwd of its own: --cd already points at the
  // directory, and a UNC process cwd makes Windows tools complain.
  const args = ['-d', distro, ...userArgs, '--cd', linuxPath]
  if (cleanPath) {
    const script = `export PATH='${cleanPath.replace(/'/g, `'\\''`)}'; exec bash -i`
    args.push('-e', 'bash', '-lc', script)
  } else {
    args.push('-e', 'bash', '-l')
  }
  run('wsl.exe', args, { cwd: process.env.SystemRoot ?? 'C:\\Windows' })
} else {
  // Leave Windows workspaces exactly as they were: their configured shell.
  run(process.env.DSH_WSL_WIN_SHELL ?? 'pwsh.exe', [], { cwd })
}
