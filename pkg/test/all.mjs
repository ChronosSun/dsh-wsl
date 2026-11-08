import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const integration = new Set(['fs.test.mjs', 'search.test.mjs', 'worktree.test.mjs', 'wsl-diff.test.mjs'])
const includeIntegration = process.env.DSH_WSL_INTEGRATION === '1'
const tests = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => includeIntegration || !integration.has(name))
  .sort()

let failed = 0
for (const name of tests) {
  process.stdout.write(`\n== ${name} ==\n`)
  const result = spawnSync(process.execPath, [join(here, name)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}
process.stdout.write(`\n${tests.length - failed}/${tests.length} test files passed\n`)
process.exit(failed ? 1 : 0)
