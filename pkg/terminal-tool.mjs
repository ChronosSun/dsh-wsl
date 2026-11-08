// Model-facing persistent terminal inside the WSL world.
//
// The Host PTY is delegated through the world's subprocess service: wsl.exe
// allocates a real tty and bash inherits it. One shell is kept per Agent
// session, so `cd`, exported variables and background work survive calls.
// This intentionally exposes run/read/interrupt/close, not raw keystrokes.

export const name = 'dsh-wsl/terminal'
export const inject = ['tools']

const sessions = new Map()
let sequence = 0

function sessionKey(exec) {
  return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? 'default')
}

function stripAnsi(value) {
  return String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function cwdFor(exec, ctx) {
  const session = exec?.agent?.session
  const header = session?.header?.cwd ?? ctx.get('workingDirectory')?.get?.(session)
  const raw = exec?.agent?.cwd && exec.agent.cwd !== '/' ? exec.agent.cwd : header
  if (typeof raw !== 'string' || raw === '') return '/'
  if (raw.startsWith('/')) return raw
  const unc = /^\\\\[?]?(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/i.exec(raw)
  if (unc) return `/${unc[2].replace(/\\/g, '/')}`
  return raw
}

async function ensureTerminal(ctx, exec) {
  const key = sessionKey(exec)
  const existing = sessions.get(key)
  if (existing && !existing.closed) return existing
  const subprocess = ctx.get('subprocess')
  if (!subprocess?.spawnTerminal) throw new Error('wsl_term: the WSL subprocess service is not mounted')
  const environment = await subprocess.terminalEnvironment?.()
  if (environment && environment.platform !== 'posix') {
    throw new Error('wsl_term: the current subprocess service is not the WSL world')
  }
  const cwd = cwdFor(exec, ctx)
  const handle = await subprocess.spawnTerminal({
    argv: [environment?.defaultShell || '/bin/bash', '-l'],
    cwd,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    shellActivity: true,
    graceMs: 5_000,
  })
  const entry = { handle, buffer: '', closed: false, cwd, next: 0 }
  handle.output.on('data', (chunk) => { entry.buffer += chunk.toString('utf8') })
  handle.done.finally(() => { entry.closed = true }).catch(() => {})
  sessions.set(key, entry)
  return entry
}

function waitFor(entry, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      if (entry.buffer.includes(marker) || entry.closed || Date.now() >= deadline) {
        resolve()
      } else {
        setTimeout(tick, 50)
      }
    }
    tick()
  })
}

async function run(entry, command, timeoutMs) {
  const token = `${Date.now().toString(36)}${(sequence++).toString(36)}`
  const begin = `__DSH_TERM_BEGIN_${token}__`
  const end = `__DSH_TERM_END_${token}__`
  entry.buffer = ''
  const script = [
    `printf '\\n%s%s\\n' '__DSH_TERM_BEGIN_' '${token}'`,
    `{ ${command}\n} 2>&1`,
    `printf '\\n%s%s%s\\n' '__DSH_TERM_END_' '${token}' "$?"`,
  ].join('\n')
  await entry.handle.write(script + '\n')
  await waitFor(entry, end, Math.max(1_000, timeoutMs))
  const raw = stripAnsi(entry.buffer)
  const beginAt = raw.indexOf(begin)
  const endAt = raw.indexOf(end)
  let output = raw
  let exitCode = null
  if (beginAt >= 0 && endAt > beginAt) output = raw.slice(beginAt + begin.length, endAt).replace(/^\r?\n/, '')
  if (endAt >= 0) {
    const after = raw.slice(endAt + end.length).match(/^(\d+)/)
    if (after) exitCode = Number(after[1])
  }
  return {
    output: output.trimEnd(),
    exitCode: exitCode ?? -1,
    timedOut: endAt < 0,
    closed: entry.closed,
  }
}

export function apply(ctx) {
  const tool = {
    name: 'wsl_term',
    description: 'Persistent real PTY shell in the WSL world. `run` executes a command in the same shell (cwd/env/background work persist), `read` returns buffered output, `interrupt` sends SIGINT to the foreground process, `close` ends the shell. Full-screen interactive input is not exposed yet.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'read', 'interrupt', 'close', 'list'] },
        command: { type: 'string', description: 'Command for action=run.' },
        timeoutMs: { type: 'number', description: 'Run timeout; defaults to 120000 and is capped at 600000.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          output: { type: 'string' },
          exitCode: { type: 'number' },
          timedOut: { type: 'boolean' },
          closed: { type: 'boolean' },
          sessions: { type: 'array', items: { type: 'string' } },
        },
        required: ['action', 'output'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: value.output || `(${value.action})` }],
    },
    async execute(args, exec) {
      const action = args?.action
      if (action === 'list') return { action, output: [...sessions.keys()].join('\n'), sessions: [...sessions.keys()] }
      const key = sessionKey(exec)
      if (action === 'close') {
        const entry = sessions.get(key)
        if (!entry) return { action, output: 'no terminal', closed: true }
        await entry.handle.terminate().catch(() => {})
        sessions.delete(key)
        return { action, output: 'closed', closed: true }
      }
      const entry = await ensureTerminal(ctx, exec)
      if (action === 'read') return { action, output: stripAnsi(entry.buffer).slice(-16_384), closed: entry.closed }
      if (action === 'interrupt') {
        const pid = await entry.handle.signalForeground('SIGINT').catch(() => 0)
        return { action, output: pid ? `SIGINT sent to ${pid}` : 'no foreground process', closed: entry.closed }
      }
      if (action !== 'run') throw new Error(`wsl_term: unknown action ${String(action)}`)
      if (typeof args?.command !== 'string' || !args.command.trim()) throw new Error('wsl_term: command is required for action=run')
      const timeout = Math.min(600_000, Math.max(1_000, Number(args?.timeoutMs) || 120_000))
      const result = await run(entry, args.command, timeout)
      return { action, ...result }
    },
  }

  const dispose = ctx.tools.register(tool)
  return () => {
    for (const entry of sessions.values()) entry.handle.terminate().catch(() => {})
    sessions.clear()
    dispose()
  }
}
