// Focused probe: how does a bare $VAR behave inside our single-script shape?
import { spawn } from 'node:child_process'

const CLEAN = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const DISTRO = 'Ubuntu-24.04'

function run(command) {
  const script = `PATH=${CLEAN}; export PATH; ${command}`
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-d', DISTRO, '--cd', '/home/chronos/develop', '--', '/bin/bash', '-c', script], { windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
  })
}

const cases = [
  'echo $PATH',
  'echo "$PATH"',
  'echo $HOME',
  'pwd; uname -s',
  'pwd; uname -s; echo $PATH',
  'pwd; uname -s; echo "$PATH"',
]

for (const command of cases) {
  const result = await run(command)
  console.log(`CMD ${JSON.stringify(command)}`)
  console.log(`  code=${result.code}`)
  console.log(`  out=${JSON.stringify(result.out.slice(0, 200))}`)
  if (result.err) console.log(`  err=${JSON.stringify(result.err.slice(0, 400))}`)
}
