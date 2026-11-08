// Model-facing bootstrap for the WSL world. Unlike wsl_project_check this can
// change the distribution, so it is dry-run by default and only runs apt as
// root inside the distro when the caller explicitly passes dryRun: false.
import { registry } from './src/registry.mjs'
import { linuxPathFromUnc } from './src/preset-default.mjs'
import { defaultDistro, userFor } from './src/settings.mjs'
import { runFix } from './src/doctor.mjs'

export const name = 'dsh-wsl/bootstrap'
export const inject = ['tools']

const RECIPES = {
  node: { commands: ['node'], packages: 'nodejs' },
  python: { commands: ['python3', 'pip3'], packages: 'python3 python3-pip python3-venv' },
  build: { commands: ['gcc', 'make'], packages: 'build-essential' },
  tools: { commands: ['curl', 'git', 'jq', 'rsync'], packages: 'ca-certificates curl git jq rsync' },
}

function distroFromUnc(value) {
  return /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)\\/i.exec(String(value ?? ''))?.[1] ?? ''
}

export function apply(ctx) {
  const tool = {
    name: 'wsl_bootstrap',
    description: 'Plan or install a small set of missing toolchains inside the WSL distribution (node, python, build, tools). Dry-run by default; installation runs apt as root inside the distro and requires dryRun: false.',
    parameters: {
      type: 'object',
      properties: {
        recipes: {
          type: 'array',
          items: { type: 'string', enum: ['node', 'python', 'build', 'tools'] },
          description: 'Recipes to plan/install. Defaults to node.',
        },
        dryRun: { type: 'boolean', description: 'Default true. Must be explicitly false to install.' },
        distro: { type: 'string', description: 'Optional distribution; defaults to the session workspace distribution.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean' },
          recipes: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
        required: ['dryRun', 'recipes', 'report'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      const headerCwd = session?.header?.cwd ?? ctx.get('workingDirectory')?.get?.(session)
      const rawCwd = exec?.agent?.cwd && exec.agent.cwd !== '/' ? exec.agent.cwd : headerCwd
      const distro = args?.distro || distroFromUnc(rawCwd) || defaultDistro()
      const requested = Array.isArray(args?.recipes) && args.recipes.length ? args.recipes : ['node']
      const recipes = [...new Set(requested)].filter((name) => Object.hasOwn(RECIPES, name))
      if (!recipes.length) throw new Error(`wsl_bootstrap: unknown recipe; use ${Object.keys(RECIPES).join(', ')}`)
      const dryRun = args?.dryRun !== false
      const broker = registry.get(distro, userFor(distro))
      if (!broker) throw new Error(`wsl_bootstrap: no broker for ${distro || '(default)'}`)
      const target = linuxPathFromUnc(rawCwd) || (rawCwd?.startsWith('/') ? rawCwd : '')
      const commands = [...new Set(recipes.flatMap((recipe) => RECIPES[recipe].commands))]
      const check = commands.map((cmd) => `printf '%s=' '${cmd}'; command -v '${cmd}' || true`).join('\n')
      const found = await broker.call('exec', { argv: ['bash', '-lc', check], cwd: target || undefined })
      const lines = found.out.trim().split(/\r?\n/).filter(Boolean)
      const missing = commands.filter((cmd) => !lines.some((line) => line.startsWith(`${cmd}=/`)))
      const plan = [
        `distro: ${distro || '(default)'}`,
        `recipes: ${recipes.join(', ')}`,
        `missing commands: ${missing.length ? missing.join(', ') : '(none)'}`,
        dryRun
          ? 'dry run — nothing has been installed'
          : 'installing as root inside the distribution',
      ]
      if (dryRun) return { dryRun, recipes, report: plan.join('\n') }
      for (const recipe of recipes) {
        const result = await runFix(distro, recipe, '', '')
        plan.push(`\n[${recipe}] exit ${result.code}`)
        if (result.out) plan.push(result.out)
        if (result.err) plan.push(result.err)
        if (result.code !== 0) break
      }
      return { dryRun, recipes, report: plan.join('\n') }
    },
  }

  const dispose = ctx.tools.register(tool)
  return () => { dispose() }
}
