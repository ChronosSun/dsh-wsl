// Validate the exact argv shape the provider now emits.
import { spawn } from 'node:child_process'

const CLEAN_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const DISTRO = 'Ubuntu-24.04'

function run(command, cwd = '/home/chronos/develop') {
  const script = `PATH=${CLEAN_PATH}; export PATH; ${command}`
  const args = ['-d', DISTRO, '--cd', cwd, '--', '/bin/bash', '-c', script]
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', args, { windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
  })
}

const cases = [
  ['printenv PATH', 'PATH 是否干净'],
  ['pwd; uname -s; echo $PATH', '你最初那条（含裸 $PATH）'],
  [`printf '%s' "with space"`, '带引号参数'],
  ['exit 7', '非零退出'],
]

for (const [command, label] of cases) {
  const first = await run(command)
  const second = await run(command)
  const stable = first.code === second.code && first.out === second.out
  console.log(`--- ${label} :: ${JSON.stringify(command)}`)
  console.log(`    code=${first.code} stable=${stable}`)
  console.log(`    out=${JSON.stringify(first.out.slice(0, 160))}`)
  if (first.err) console.log(`    err=${JSON.stringify(first.err.slice(0, 160))}`)
}
