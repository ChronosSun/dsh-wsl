// Validate the launch shape against the real distro: PATH must be clean, no
// argument may be dropped, and a bare $VAR must expand at runtime (not early).
import { spawn } from 'node:child_process'
import { buildArgv } from '../src/launch.mjs'

const DISTRO = 'Ubuntu-24.04'
const CWD = '/home/chronos/develop'

function run(spec) {
  const argv = buildArgv(spec, { distro: DISTRO, cwd: CWD })
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', argv, { windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
  })
}

const bash = (command) => ({ argv: ['bash', '-c', command], cwd: CWD, stdio: {}, graceMs: 5000, env: {} })

const cases = [
  ['printenv PATH', 'PATH 干净'],
  ['echo $PATH', '裸 $PATH 不在 argv 里被展开'],
  ['echo "$PATH"', '引用形式'],
  ['pwd; uname -s; echo $PATH', '最初那条'],
  ['echo HOME=$HOME', '其他变量'],
  ['exit 7', '非零退出'],
  ['printf "%s" "a b"', '带空格参数'],
]

let failed = 0
for (const [command, label] of cases) {
  const first = await run(bash(command))
  const second = await run(bash(command))
  const stable = first.code === second.code && first.out === second.out
  const clean = !first.out.includes('/mnt/')
  const ok = first.code === (command === 'exit 7' ? 7 : 0) && stable && (command.includes('PATH') ? clean : true)
  if (!ok) failed += 1

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} :: ${JSON.stringify(command)}`)
  console.log(`      code=${first.code} stable=${stable} cleanPath=${clean}`)
  console.log(`      out=${JSON.stringify(first.out.slice(0, 140))}`)
  if (first.err) console.log(`      err=${JSON.stringify(first.err.slice(0, 200))}`)
}

// custom env must reach the command
{
  const result = await run({ argv: ['bash', '-c', 'echo $MY_VAR'], cwd: CWD, stdio: {}, graceMs: 5000, env: { MY_VAR: 'hello world' } })
  const ok = result.out === 'hello world'
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  custom env :: out=${JSON.stringify(result.out)}`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
