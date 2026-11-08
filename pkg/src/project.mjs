// Shared project-doctor script for the panel route and the model tool.
// Everything here is read-only: manifests are inspected and commands are
// looked up with `command -v`; nothing is installed.
import { bashScript } from './doctor.mjs'

const MANIFESTS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  '.nvmrc',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'Dockerfile',
  'docker-compose.yml',
  'Makefile',
  'CMakeLists.txt',
]

export const PROJECT_TOOLS = [
  'node', 'npm', 'pnpm', 'yarn', 'bun',
  'cargo', 'go', 'python3', 'pip3',
  'make', 'cmake', 'docker',
  'rg', 'fd', 'git', 'ssh',
]

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Shell script that prints `workspace=`, `manifest=`, `tool=` and `missing=`. */
export function projectScript(target) {
  return [
    `cd ${quote(target)} || { echo "workspace-missing"; exit 2; }`,
    'echo "workspace=$PWD"',
    `for f in ${MANIFESTS.map(quote).join(' ')}; do [ -f "$f" ] && echo "manifest=$f"; done`,
    `for t in ${PROJECT_TOOLS.map(quote).join(' ')}; do`,
    '  p=$(command -v "$t" 2>/dev/null || true)',
    '  if [ -n "$p" ]; then echo "tool=$t|$p"; else echo "missing=$t"; fi',
    'done',
    'printf "%s\\n" "$PATH" | tr ":" "\\n" | grep "^/mnt/" | head -5 | sed "s/^/winpath=/"',
  ].join('\n')
}

export function renderProjectReport(out) {
  const lines = String(out ?? '').trim().split(/\r?\n/).filter(Boolean)
  const manifests = lines.filter((line) => line.startsWith('manifest=')).map((line) => line.slice(9))
  const tools = lines.filter((line) => line.startsWith('tool=')).map((line) => {
    const [name, path] = line.slice(5).split('|')
    return `${name} → ${path}`
  })
  const missing = lines.filter((line) => line.startsWith('missing=')).map((line) => line.slice(8))
  const winpaths = lines.filter((line) => line.startsWith('winpath=')).map((line) => line.slice(8))
  return [
    lines.find((line) => line.startsWith('workspace=')) || '',
    `manifests: ${manifests.length ? manifests.join(', ') : '(none)'}`,
    tools.length ? `tools: ${tools.join(' · ')}` : '',
    missing.length ? `missing: ${missing.join(', ')}` : 'missing: (none)',
    winpaths.length ? `Windows directories on PATH: ${winpaths.join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

/** Host-side project check; used by the panel route. */
export async function runProjectCheck(distro, user, path) {
  const target = String(path ?? '').trim()
  if (!target) throw Object.assign(new Error('project path is required'), { code: 'PROJECT_PATH_REQUIRED' })
  if (!target.startsWith('/')) throw Object.assign(new Error('project path must be an absolute Linux path'), { code: 'PROJECT_PATH_INVALID' })
  const result = await bashScript(distro, user, projectScript(target), { timeoutMs: 30_000 })
  return {
    path: target,
    distro,
    user,
    code: result.code,
    report: renderProjectReport(result.out),
    raw: result.out,
    error: result.code === 0 ? '' : (result.err || `wsl exited ${result.code}`),
  }
}
