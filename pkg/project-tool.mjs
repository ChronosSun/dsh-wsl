// Read-only project doctor inside the WSL world.
//
// Answers the question a generic distro doctor cannot: does this repository's
// toolchain actually exist in this distribution? It only reads manifests and
// prints what is missing; it never installs anything.
import { registry } from './src/registry.mjs'
import { linuxPathFromUnc } from './src/preset-default.mjs'
import { defaultDistro, userFor } from './src/settings.mjs'
import { projectScript, renderProjectReport } from './src/project.mjs'

export const name = 'dsh-wsl/project'
export const inject = ['tools']

function brokerFor(cwd, distro) {
  return registry.get(distro, userFor(distro))
}

function distroFromUnc(value) {
  return /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)\\/i.exec(String(value ?? ''))?.[1] ?? ''
}

export function apply(ctx) {
  const tool = {
    name: 'wsl_project_check',
    description: 'Read-only WSL project doctor: inspect a directory for package/lock/build manifests and check whether the tools they need exist in the distribution. Never installs anything.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Linux directory to inspect; defaults to the current WSL session workspace.' },
        distro: { type: 'string', description: 'Optional distribution name; defaults to the session workspace distribution.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          distro: { type: 'string' },
          report: { type: 'string' },
        },
        required: ['path', 'distro', 'report'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      const headerCwd = session?.header?.cwd ?? ctx.get('workingDirectory')?.get?.(session)
      const rawCwd = exec?.agent?.cwd && exec.agent.cwd !== '/' ? exec.agent.cwd : headerCwd
      const distro = args?.distro || distroFromUnc(rawCwd) || defaultDistro()
      const target = args?.path || linuxPathFromUnc(rawCwd) || (rawCwd?.startsWith('/') ? rawCwd : '')
      if (!target) throw new Error('wsl_project_check: pass a Linux path; the session is not in a WSL workspace')
      const broker = brokerFor(rawCwd, distro)
      if (!broker) throw new Error(`wsl_project_check: no broker for ${distro || '(default)'}`)
      const script = projectScript(target)
      const result = await broker.call('exec', { argv: ['bash', '-lc', script], cwd: target })
      if (result.code !== 0) throw new Error(`wsl_project_check: ${result.err || result.out || `exit ${result.code}`}`)
      return { path: target, distro, report: renderProjectReport(result.out) }
    },
  }

  const dispose = ctx.tools.register(tool)
  return () => { dispose() }
}
