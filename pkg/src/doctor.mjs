// Doctor: read-only WSL/distro checks and the few guided fixes we can run
// without a TTY (Node install, SSH key/config). Everything runs through
// wsl.exe with base64 scripts so `$` never reaches wsl.exe's argv.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultDistro, readSettings, userFor, writeSettings } from './settings.mjs'

const WSL_EXE = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wsl.exe`

function runWsl(args, { timeoutMs = 20_000, utf16 = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(WSL_EXE, args, { windowsHide: true })
    let out = '', err = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out: out.trim(), err: err.trim() })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish(-1)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk.toString(utf16 ? 'utf16le' : 'utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString(utf16 ? 'utf16le' : 'utf8') })
    child.on('error', (error) => { err += String(error); finish(-1) })
    child.on('close', (code) => finish(code))
  })
}

function base64Script(script) {
  return Buffer.from(script, 'utf8').toString('base64')
}

async function bashScript(distro, user, script, options) {
  const args = ['-d', distro]
  if (user) args.push('-u', user)
  args.push('--', 'bash', '-lc', `printf %s ${base64Script(script)} | base64 -d | bash`)
  return runWsl(args, options)
}

/** Distros installed for this Windows user, in `wsl -l -q` order. */
export async function listWslDistros() {
  const result = await runWsl(['-l', '-q'], { utf16: true })
  return [...new Set(result.out.replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
}

export async function wslVersion() {
  const result = await runWsl(['--version'], { utf16: true })
  const lines = result.out.replace(/\0/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return { ok: result.code === 0, lines, raw: lines.join(' | ') }
}

function readWslConfig() {
  const file = join(homedir(), '.wslconfig')
  try {
    const text = readFileSync(file, 'utf8')
    const mode = /^\s*networkingMode\s*=\s*(\S+)/im.exec(text)?.[1] ?? ''
    const localhost = /^\s*localhostForwarding\s*=\s*(\S+)/im.exec(text)?.[1] ?? ''
    const memory = /^\s*memory\s*=\s*(\S+)/im.exec(text)?.[1] ?? ''
    return { present: true, file, networkingMode: mode || 'nat (default)', localhostForwarding: localhost || 'true (default)', memory }
  } catch {
    return { present: false, file, networkingMode: 'nat (default)', localhostForwarding: 'true (default)', memory: '' }
  }
}

function parseKeyValues(output) {
  const values = {}
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    values[line.slice(0, at)] = line.slice(at + 1)
  }
  return values
}

async function checkDistro(distro, user) {
  const script = [
    'echo "USER=$(id -un)"',
    'echo "DEFAULT_USER=$(id -un)"',
    'echo "UID=$(id -u)"',
    'echo "HOME=$HOME"',
    'echo "SHELL=$SHELL"',
    'echo "NODE=$(command -v node || true)"',
    'echo "NODE_VERSION=$(node -v 2>/dev/null || true)"',
    'echo "GIT=$(command -v git || true)"',
    'echo "GIT_VERSION=$(git --version 2>/dev/null || true)"',
    'echo "SSH=$(command -v ssh || true)"',
    'echo "SSH_VERSION=$(ssh -V 2>&1 | head -1)"',
    'echo "BASH=$(command -v bash || true)"',
    'echo "KEYS=$(ls ~/.ssh/*.pub 2>/dev/null | wc -l)"',
    'echo "PRIVATE_KEYS=$(ls ~/.ssh/id_* 2>/dev/null | grep -v "\\.pub$" | wc -l)"',
    'echo "SSH_CONFIG=$(test -f ~/.ssh/config && echo yes || echo no)"',
    'echo "LOGIN_PATH_MNT=$(printf "%s" "$PATH" | tr ":" "\\n" | grep -c "^/mnt/")"',
    'CLEAN_PATH=$(printf "%s" "$PATH" | tr ":" "\\n" | grep -v "^/mnt/" | paste -sd: -)',
    'echo "CLEAN_PATH=$CLEAN_PATH"',
    'echo "CLEAN_PATH_MNT=$(printf "%s" "$CLEAN_PATH" | tr ":" "\\n" | grep -c "^/mnt/")"',
    'echo "PATH=$PATH"',
    "getent passwd | awk -F: '$3>=1000 && $3<65534 {print \"USER_ENTRY=\"$1\":\"$3\":\"$6\":\"$7}'",
  ].join('\n')
  const result = await bashScript(distro, user, script, { timeoutMs: 20_000 })
  const values = parseKeyValues(result.out)
  const users = []
  for (const line of result.out.split(/\r?\n/)) {
    if (!line.startsWith('USER_ENTRY=')) continue
    const [name, uid, home, shell] = line.slice('USER_ENTRY='.length).split(':')
    if (!name || !Number.isFinite(Number(uid))) continue
    users.push({ name, uid: Number(uid), home: home ?? '', shell: shell ?? '' })
  }
  users.sort((left, right) => left.uid - right.uid || left.name.localeCompare(right.name))
  const uid = Number(values.UID ?? -1)
  return {
    distro,
    user: values.USER ?? '',
    defaultUser: values.DEFAULT_USER ?? values.USER ?? '',
    requestedUser: user ?? '',
    uid,
    root: uid === 0,
    home: values.HOME ?? '',
    shell: values.SHELL ?? '',
    users,
    node: { path: values.NODE ?? '', version: values.NODE_VERSION ?? '' },
    git: { path: values.GIT ?? '', version: values.GIT_VERSION ?? '' },
    ssh: { path: values.SSH ?? '', version: values.SSH_VERSION ?? '' },
    bash: values.BASH ?? '',
    keys: Number(values.KEYS ?? 0),
    privateKeys: Number(values.PRIVATE_KEYS ?? 0),
    sshConfig: values.SSH_CONFIG === 'yes',
    path: {
      value: values.CLEAN_PATH ?? values.PATH ?? '',
      loginMntEntries: Number(values.LOGIN_PATH_MNT ?? 0),
      mntEntries: Number(values.CLEAN_PATH_MNT ?? 0),
    },
    error: result.code === 0 ? '' : (result.err || `wsl exited ${result.code}`),
  }
}

/** Lightweight user discovery used at Host boot and by the doctor route. */
export async function detectUsers(distro) {
  const check = await checkDistro(distro, '')
  return { defaultUser: check.defaultUser, root: check.root, users: check.users }
}

/** Read-only doctor snapshot; the panel renders it. */
export async function runDoctor(ctx, plugin) {
  const [version, distros] = await Promise.all([wslVersion(), listWslDistros()])
  const settings = readSettings()
  const checks = []
  for (const distro of distros) {
    const user = settings.users[distro] ?? ''
    checks.push(await checkDistro(distro, user))
  }
  // A distro whose default user is root should not silently drive the Agent as
  // root: prefer its first normal user once we know one.
  const users = { ...settings.users }
  let changed = false
  for (const check of checks) {
    if (check.root && check.users.length > 0 && !users[check.distro]) {
      users[check.distro] = check.users[0].name
      changed = true
    }
  }
  if (changed) {
    writeSettings({ users })
    for (const check of checks) {
      if (users[check.distro] && users[check.distro] !== check.requestedUser) {
        Object.assign(check, await checkDistro(check.distro, users[check.distro]))
      }
    }
  }
  return {
    at: new Date().toISOString(),
    wsl: { version, distros },
    network: { ...readWslConfig(), defaultDistro: defaultDistro() },
    settings: changed ? readSettings() : settings,
    checks,
    plugin,
  }
}

/** Guided fixes that need no interactive password. */
export async function runFix(distro, action, requestedUser, requestedName = '') {
  const user = requestedUser || userFor(distro)
  if (action === 'node') {
    // System packages belong to the distro default/root identity; the Agent's
    // normal user usually has no passwordless sudo.
    const nodeUser = requestedUser || ''
    const script = [
      'if command -v node >/dev/null 2>&1; then echo "ALREADY"; command -v node; node -v; exit 0; fi',
      'if ! command -v apt-get >/dev/null 2>&1; then echo "NO_APT"; exit 2; fi',
      'if [ "$(id -u)" = 0 ]; then SUDO=""; else if ! sudo -n true 2>/dev/null; then echo "NO_SUDO"; exit 3; fi; SUDO="sudo -n"; fi',
      '$SUDO apt-get update -qq && DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq nodejs',
      'command -v node; node -v',
    ].join('\n')
    const result = await bashScript(distro, nodeUser, script, { timeoutMs: 300_000 })
    return { action, distro, user: nodeUser, code: result.code, out: result.out, err: result.err }
  }
  if (action === 'ssh-key') {
    const script = [
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
      'if [ ! -f ~/.ssh/id_ed25519 ]; then ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C "dsh-wsl" >/dev/null; fi',
      'cat ~/.ssh/id_ed25519.pub',
    ].join('\n')
    const result = await bashScript(distro, user, script, { timeoutMs: 30_000 })
    return { action, distro, user, code: result.code, out: result.out, err: result.err }
  }
  if (action === 'ssh-config') {
    const script = [
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
      'touch ~/.ssh/config && chmod 600 ~/.ssh/config',
      'if ! grep -qE "ControlMaster|dsh-wsl" ~/.ssh/config; then',
      "  printf '%s\\n' '# dsh-wsl: reuse one SSH connection across Agent calls' 'Host *' '  ServerAliveInterval 30' '  ServerAliveCountMax 3' '  ConnectTimeout 10' '  ControlMaster auto' '  ControlPath ~/.ssh/cm-%r@%h:%p' '  ControlPersist 10m' >> ~/.ssh/config",
      'fi',
      'cat ~/.ssh/config',
    ].join('\n')
    const result = await bashScript(distro, user, script, { timeoutMs: 30_000 })
    return { action, distro, user, code: result.code, out: result.out, err: result.err }
  }
  if (action === 'user') {
    const name = /^[a-z_][a-z0-9_-]{0,31}$/.test(requestedName) ? requestedName : 'chronos'
    const createAs = requestedUser || ''
    const script = [
      `NAME=${name}`,
      'if getent passwd "$NAME" >/dev/null 2>&1; then id "$NAME"; exit 0; fi',
      'if [ "$(id -u)" = 0 ]; then SUDO=""; else if ! sudo -n true 2>/dev/null; then echo "NO_SUDO"; exit 3; fi; SUDO="sudo -n"; fi',
      '$SUDO useradd -m -s /bin/bash "$NAME"',
      '$SUDO passwd -l "$NAME" >/dev/null 2>&1 || true',
      'id "$NAME"',
    ].join('\n')
    const result = await bashScript(distro, createAs, script, { timeoutMs: 60_000 })
    return { action, distro, user: createAs || 'root', name, code: result.code, out: result.out, err: result.err }
  }
  throw Object.assign(new Error(`unknown doctor action: ${action}`), { code: 'DOCTOR_UNKNOWN_ACTION' })
}
