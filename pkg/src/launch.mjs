// Builds the wsl.exe argv. Pure functions, no DSH dependency, unit-testable.
//
// Two hard-won constraints:
//
// 1. `wsl.exe` silently drops the arguments that follow a command
//    (`sh -c 'echo $#' sh a b c` answers 0), so nothing may travel as a
//    trailing argument — everything goes inside the single `-c` script.
// 2. `wsl.exe` expands `$VAR` in its command line against the *target* Linux
//    environment before the script runs. A bare `$PATH` therefore arrives as
//    the dirty default PATH, whose `Program Files (x86)` breaks the second
//    parse. The script is base64-encoded so no `$` ever appears in argv.

export const CLEAN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

// Used before the broker has resolved the distribution's login PATH: keep the
// usual Linux system dirs plus the user-space toolchain locations, but never
// `/mnt/*` (Windows interop binaries must stay unreachable).
const FALLBACK_PATH_EXPR = `"$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.hermes/node/bin:${CLEAN_PATH}"`

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** A `bash -c <script>` request keeps its command; anything else is exec'd. */
export function commandBody(argv) {
  if (argv.length >= 3 && /(^|\/)bash$/.test(argv[0]) && argv[1] === '-c') return String(argv[2])
  return 'exec ' + argv.map(shellQuote).join(' ')
}

export function buildScript(spec, { nonce = Date.now().toString(36), path } = {}) {
  const env = Object.entries(spec.env ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}; `)
    .join('')
  const body = commandBody(spec.argv)
  const encoded = Buffer.from(body, 'utf8').toString('base64')
  const file = `/tmp/.dsh-wsl-${nonce}.sh`
  // `path` is the distribution's login PATH with `/mnt/*` removed, resolved by
  // the broker. Until it exists, the fallback keeps user toolchains
  // (`~/.local/bin`, cargo, …) reachable while still excluding Windows.
  const pathExpr = path ? shellQuote(path) : FALLBACK_PATH_EXPR
  // No `$` anywhere in argv: the script is base64-decoded inside WSL, so `$`
  // in FALLBACK_PATH_EXPR expands there, never in wsl.exe's own command line.
  return `PATH=${pathExpr}; export PATH; ${env}trap 'rm -f ${file}' EXIT; printf %s ${encoded} | base64 -d > ${file}; /bin/bash ${file}`
}

export function buildArgv(spec, { distro, user = '', cwd, path, nonce } = {}) {
  const args = []
  if (distro) args.push('-d', distro)
  if (user) args.push('-u', user)
  if (cwd) args.push('--cd', cwd)
  args.push('--', '/bin/bash', '-c', buildScript(spec, { nonce, path }))
  return args
}
