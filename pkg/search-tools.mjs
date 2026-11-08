// `grep` and `glob` inside the WSL world.
//
// The host's own search package spawns a bundled **Windows** ripgrep, which a
// Linux world cannot run. These tools walk the tree inside the distribution
// instead, through the broker, with no external binary at all.
import { registry } from './src/registry.mjs'
import { userFor } from './src/settings.mjs'
import { userFromLinuxPath } from './src/path-user.mjs'

const text = (value) => [{ type: 'text', text: value }]

/** The model still sees a UNC cwd, so a host path may arrive here. */
function toLinuxPath(value, fallback) {
  const raw = String(value ?? '')
  if (!raw) return fallback ?? '/'
  if (raw.startsWith('/')) return raw
  const unc = /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/i.exec(raw)
  if (unc) return `/${unc[2].replace(/\\/g, '/')}`
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(raw)
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
  return fallback ?? raw
}

function brokerFor(config, cwd = '') {
  const distro = config?.distro ?? ''
  return registry.get(distro, config?.user || userFromLinuxPath(cwd) || userFor(distro))
}

export const name = 'dsh-wsl/search'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'glob',
    description: 'Find files by glob pattern inside the WSL distribution. Returns paths, oldest-first is not guaranteed; hidden files are included. In a Git worktree, files ignored by .gitignore are skipped; otherwise .git and node_modules are pruned. A pattern without "/" matches basenames at any depth.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob such as "**/*.ts" or "*.json".' },
        path: { type: 'string', description: 'Directory to search (Linux path). Required: pass the session working directory.' },
      },
      required: ['pattern', 'path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { paths: { type: 'array' }, truncated: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => text((value.paths ?? []).join('\n') || 'no files matched'),
    },
    async execute(args, exec) {
      const cwd = exec?.agent?.cwd ?? config.defaultCwd ?? '/'
      const root = toLinuxPath(args.path, cwd)
      return brokerFor(config, cwd).call('glob', { path: root, pattern: args.pattern, max: 1000 })
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'grep',
    description: 'Search file contents with a JavaScript regular expression inside the WSL distribution. Results are grouped by file with line numbers. In a Git worktree, files ignored by .gitignore are skipped; otherwise .git and node_modules are pruned; files over 2 MiB are skipped.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        path: { type: 'string', description: 'Directory to search (Linux path). Required: pass the session working directory.' },
        include: { type: 'string', description: 'Optional file-name glob filter, such as "*.ts".' },
      },
      required: ['pattern', 'path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { files: { type: 'array' }, truncated: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => {
        const lines = []
        for (const file of value.files ?? []) {
          for (const match of file.matches ?? []) lines.push(`${file.path}:${match.lineNumber}: ${match.line}`)
        }
        if (value.truncated) lines.push('[truncated]')
        return text(lines.join('\n') || 'no matches')
      },
    },
    async execute(args, exec) {
      const cwd = exec?.agent?.cwd ?? config.defaultCwd ?? '/'
      const root = toLinuxPath(args.path, cwd)
      return brokerFor(config, cwd).call('grep', { path: root, pattern: args.pattern, include: args.include, max: 250 })
    },
  }))

  return () => { for (const dispose of disposers) dispose() }
}

