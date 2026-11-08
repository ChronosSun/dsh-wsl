// Model-facing path conversion inside a WSL session.
//
// The world deliberately keeps Windows binaries out of PATH, but real work
// sometimes crosses the boundary (opening a file in a Windows app, passing a
// path to an interop executable). This tool converts one path; it does not
// touch the filesystem.
import { defaultDistro } from './src/settings.mjs'

export const name = 'dsh-wsl/path'
export const inject = ['tools']

function uncParts(value) {
  const match = /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i.exec(String(value ?? ''))
  if (!match) return undefined
  return { distro: match[1], rest: match[2] ?? '' }
}

function driveToLinux(value) {
  const match = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(value)
  if (!match) return undefined
  const rest = (match[2] ?? '').replace(/\\/g, '/')
  return `/mnt/${match[1].toLowerCase()}${rest ? `/${rest}` : ''}`
}

function linuxToWindows(value, distro) {
  const mount = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(value)
  if (mount) {
    const rest = (mount[2] ?? '').replace(/\//g, '\\')
    return `${mount[1].toUpperCase()}:\\${rest}`
  }
  if (!distro) throw new Error('wsl_path: cannot determine the distribution; pass a WSL workspace path or set the default distribution')
  return `\\\\wsl.localhost\\${distro}${value.replace(/\//g, '\\')}`
}

export function convertPath(value, distro = '') {
  const input = String(value ?? '').trim()
  if (!input) throw new Error('wsl_path: path is required')

  if (input.startsWith('/')) {
    const targetDistro = distro || defaultDistro()
    return {
      input,
      linux: input,
      windows: linuxToWindows(input, targetDistro),
      distro: targetDistro,
    }
  }

  const unc = uncParts(input)
  if (unc) {
    return {
      input,
      linux: unc.rest ? `/${unc.rest.replace(/\\/g, '/')}` : '/',
      windows: input,
      distro: distro || unc.distro,
    }
  }

  const linux = driveToLinux(input)
  if (linux) {
    return {
      input,
      linux,
      windows: input,
      distro: distro || defaultDistro(),
    }
  }

  throw new Error('wsl_path: expected a Linux absolute path, a Windows drive path (C:\\...) or a \\\\wsl.localhost\\<distro>\\... path')
}

function distroFromCwd(cwd) {
  return uncParts(cwd)?.distro ?? ''
}

export function apply(ctx) {
  const tool = {
    name: 'wsl_path',
    description: 'Convert a path between the WSL distribution (Linux absolute) and Windows (drive path or \\\\wsl.localhost\\<distro>\\...). Read-only; returns both forms and the distribution.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute Linux path, Windows drive path, or \\\\wsl.localhost\\<distro>\\... path.' },
        distro: { type: 'string', description: 'Optional distribution name for a Linux path; defaults to the session workspace distribution.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          input: { type: 'string' },
          linux: { type: 'string' },
          windows: { type: 'string' },
          distro: { type: 'string' },
        },
        required: ['input', 'linux', 'windows', 'distro'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `linux: ${value.linux}\nwindows: ${value.windows}\ndistro: ${value.distro || '(default)'}` }],
    },
    execute(args, exec) {
      const session = exec?.agent?.session
      const headerCwd = session?.header?.cwd ?? ctx.get('workingDirectory')?.get?.(session)
      const cwd = exec?.agent?.cwd && exec.agent.cwd !== '/' ? exec.agent.cwd : headerCwd
      const distro = args?.distro || distroFromCwd(cwd) || defaultDistro()
      return convertPath(args?.path, distro)
    },
  }

  const dispose = ctx.tools.register(tool)
  return () => { dispose() }
}
