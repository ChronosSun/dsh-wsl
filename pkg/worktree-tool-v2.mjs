// Model-facing worktree creation inside the WSL world.
//
// The shipped `create_worktree` tool is a Host runtime: it enters the checkout
// by changing the Session working directory, which resolves through the Host
// filesystem. That cannot work for a Linux path. This tool creates the same
// kind of retained checkout with Linux git and returns its path; the Session
// cwd stays unchanged, so callers pass `workdir`/the explicit path instead.
import { registry } from './src/registry.mjs'
import { linuxPathFromUnc } from './src/preset-default.mjs'
import { userFor } from './src/settings.mjs'

export const name = 'dsh-wsl/worktree'
export const inject = ['tools']

function brokerFor(cwd) {
  const match = /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)\\/i.exec(String(cwd ?? ''))
  const distro = match ? match[1] : ''
  return registry.get(distro, userFor(distro))
}

function sanitize(name) {
  return String(name ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function apply(ctx) {
  const tool = {
    name: 'create_wsl_worktree',
    description: 'Create a retained Git worktree inside the WSL distribution. Returns its Linux path, branch and base commit. The Session working directory does not change: pass the returned path explicitly (or as workdir) to later tools.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional worktree/branch suffix; defaults to a timestamp.' },
        from: { type: 'string', description: 'Optional commit/ref to start from; defaults to HEAD.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          branch: { type: 'string' },
          baseCommit: { type: 'string' },
          repositoryRoot: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: `worktree ${value.path}\nbranch ${value.branch}\nbase ${value.baseCommit}` }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      const agentCwd = exec?.agent?.cwd
      const headerCwd = session?.header?.cwd ?? ctx.get('workingDirectory')?.get?.(session)
      // `agent.cwd` can be `/` in the tool context even when the Session is in
      // a WSL workspace; prefer the recorded UNC cwd in that case.
      const source = (typeof agentCwd === 'string' && agentCwd !== '' && agentCwd !== '/') ? agentCwd : (headerCwd || agentCwd || '/')
      const linux = linuxPathFromUnc(source) ?? (source.startsWith('/') ? source : undefined)
      if (linux === undefined) throw new Error(`create_wsl_worktree: the Session is not in a WSL workspace (cwd=${source})`)
      const broker = brokerFor(source)
      const rootResult = await broker.call('exec', { argv: ['git', '-C', linux, 'rev-parse', '--show-toplevel'], cwd: linux })
      if (rootResult.code !== 0) {
        throw new Error(`create_wsl_worktree: not a Git repository: ${rootResult.err || rootResult.out} (source=${source} linux=${linux} session=${session?.id ?? ''} header=${headerCwd ?? ''} agentCwd=${agentCwd ?? ''} keys=${Object.keys(exec?.agent ?? {}).join(',')})`)
      }
      const repositoryRoot = rootResult.out.trim()
      // Keep the retained checkouts out of the parent's status/snapshots; the
      // diff recorder also excludes this path, but the Host recorder reads Git
      // directly and needs the exclude file.
      try {
        const exclude = await broker.call('exec', {
          argv: ['git', '-C', repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
          cwd: repositoryRoot,
        })
        let excludePath = exclude.out.trim()
        if (!excludePath.startsWith('/')) excludePath = `${repositoryRoot.replace(/\/+$/, '')}/${excludePath}`
        if (excludePath) {
          await broker.call('exec', {
            argv: ['bash', '-c', `grep -qxF '.agents/worktrees/' ${shellQuote(excludePath)} 2>/dev/null || printf '%s\\n' '.agents/worktrees/' >> ${shellQuote(excludePath)}`],
            cwd: repositoryRoot,
          })
        }
      } catch {}
      const suffix = sanitize(args?.name) || `wt-${Date.now().toString(36)}`
      const branch = `dsh/${suffix}`
      const target = `${repositoryRoot.replace(/\/+$/, '')}/.agents/worktrees/${suffix}`
      const from = args?.from ? String(args.from) : 'HEAD'
      const created = await broker.call('exec', {
        argv: ['git', '-C', repositoryRoot, 'worktree', 'add', '-b', branch, target, from],
        cwd: repositoryRoot,
      })
      if (created.code !== 0) throw new Error(`create_wsl_worktree: ${created.err || created.out || `git exited ${created.code}`}`)
      const base = await broker.call('exec', { argv: ['git', '-C', target, 'rev-parse', 'HEAD'], cwd: target })
      return { path: target, branch, baseCommit: base.out.trim(), repositoryRoot }
    },
  }

  const dispose = ctx.tools.register(tool)
  return () => { dispose() }
}
