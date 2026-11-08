// One-off local benchmark: Windows 9P metadata vs WSL-native fs vs broker RPC.
// Run: node tools/bench-fs.mjs
import { readFileSync } from 'node:fs'
import { WslBroker } from '../pkg/src/broker.mjs'

const UNC = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\chronos\\develop\\source\\0411.cpp'
const LINUX = '/home/chronos/develop/source/0411.cpp'
const N = 1000

const fs = await import('node:fs')
const start = process.hrtime.bigint()
for (let i = 0; i < N; i++) fs.statSync(UNC)
const windowsMs = Number(process.hrtime.bigint() - start) / 1e6

const helperSource = readFileSync(new URL('../pkg/src/helper.mjs', import.meta.url), 'utf8')
const broker = new WslBroker({ distro: 'Ubuntu-24.04', user: 'chronos', helperSource })
await broker.connect()
const startBroker = process.hrtime.bigint()
for (let i = 0; i < N; i++) await broker.call('stat', { path: LINUX })
const brokerMs = Number(process.hrtime.bigint() - startBroker) / 1e6
await broker.disconnect('bench')

console.log(`windows 9P stat x${N}: ${windowsMs.toFixed(1)} ms (${(windowsMs / N).toFixed(3)} ms/op)`)
console.log(`broker RPC stat x${N}: ${brokerMs.toFixed(1)} ms (${(brokerMs / N).toFixed(3)} ms/op)`)

// readdir/list on a large directory
const DIR_UNC = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\chronos\\.hermes\\node\\lib\\node_modules'
const DIR_LINUX = '/home/chronos/.hermes/node/lib/node_modules'
const M = 20
const startDir = process.hrtime.bigint()
for (let i = 0; i < M; i++) fs.readdirSync(DIR_UNC)
const dirMs = Number(process.hrtime.bigint() - startDir) / 1e6

const broker2 = new WslBroker({ distro: 'Ubuntu-24.04', user: 'chronos', helperSource })
await broker2.connect()
const startList = process.hrtime.bigint()
for (let i = 0; i < M; i++) await broker2.call('list', { path: DIR_LINUX })
const listMs = Number(process.hrtime.bigint() - startList) / 1e6
await broker2.disconnect('bench')
console.log(`windows 9P readdir x${M}: ${dirMs.toFixed(1)} ms (${(dirMs / M).toFixed(2)} ms/op)`)
console.log(`broker RPC list x${M}: ${listMs.toFixed(1)} ms (${(listMs / M).toFixed(2)} ms/op)`)

// cold wsl.exe per-command overhead
const { spawnSync } = await import('node:child_process')
const K = 10
const startSpawn = process.hrtime.bigint()
for (let i = 0; i < K; i++) spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'true'], { windowsHide: true })
const spawnMs = Number(process.hrtime.bigint() - startSpawn) / 1e6
console.log(`wsl.exe cold command x${K}: ${spawnMs.toFixed(1)} ms (${(spawnMs / K).toFixed(1)} ms/op)`)
