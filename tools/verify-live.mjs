// Post-restart acceptance probe for the host-side pieces. The web server port
// changes across Desktop restarts, so this probes the current GUI ports (or
// DSH_URL) instead of hard-coding one. Run from the source checkout:
//   node tools/verify-live.mjs
//   DSH_URL=http://127.0.0.1:12450 node tools/verify-live.mjs
import { execFileSync } from 'node:child_process'

const failures = []
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

function listeningPorts() {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const ports = new Set()
    for (const line of out.split(/\r?\n/)) {
      const match = /\bTCP\s+\S+:(\d+)\s+\S+\s+LISTENING\b/i.exec(line)
      if (match) ports.add(Number(match[1]))
    }
    return [...ports]
  } catch {
    return []
  }
}

async function findBase() {
  const explicit = process.env.DSH_URL?.replace(/\/+$/, '')
  const ports = explicit ? [] : [...new Set([12450, 5936, 3529, ...listeningPorts()])]
  const candidates = explicit ? [explicit] : ports.map((port) => `http://127.0.0.1:${port}`)
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/dsh-wsl/state`, { signal: AbortSignal.timeout(1200) })
      if (response.ok) return candidate
    } catch {}
  }
  throw new Error(`no DSH web server found; pass DSH_URL with the current GUI URL`)
}

async function main() {
  const base = await findBase()
  console.log(`Using ${base}`)
  async function json(path) {
    const response = await fetch(`${base}${path}`)
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response.json()
  }

  const state = await json('/dsh-wsl/state')
  check('profile/host version 1.7.3', state.version === '1.7.3', `live=${state.version}`)
  check('wsl diff companion installed', state.wslDiff?.installed === true)
  check('all host capabilities present', Object.values(state.capabilities ?? {}).every(Boolean),
    Object.entries(state.capabilities ?? {}).filter(([, ok]) => !ok).map(([name]) => name).join(',') || '')
  const doctor = await json('/dsh-wsl/doctor')
  check('doctor sees a WSL version', (doctor.wsl?.version?.lines ?? []).length > 0, doctor.wsl?.version?.lines?.[0] ?? '')
  for (const distro of doctor.checks ?? []) {
    check(`${distro.distro}: Linux node`, Boolean(distro.node?.path), distro.node?.version || 'missing')
    check(`${distro.distro}: clean PATH has no /mnt`, distro.path?.mntEntries === 0, `login=${distro.path?.loginMntEntries}`)
  }
  await json('/dsh-wsl/settings')
  check('settings endpoint', true)

  console.log('\nManual after restart:')
  console.log('- new WSL Session shows create_wsl_worktree and returns path/branch/base')
  console.log('- panel Doctor/Settings render')
  console.log('- terminal launcher PATH: node tools/probe-terminal.mjs')
  console.log(failures.length === 0 ? '\nHOST ACCEPTANCE PASS' : `\n${failures.length} FAILED`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`verify-live: ${error.message}`)
  process.exitCode = 2
})
