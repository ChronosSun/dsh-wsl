// WSL filesystem provider — acceptance test against the real distro.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WslBroker } from '../src/broker.mjs'
import { createWslFileSystem } from '../src/fs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const helperSource = await readFile(join(here, '..', 'src', 'helper.mjs'), 'utf8')
const DISTRO = process.env.DSH_WSL_PROBE_DISTRO ?? 'Ubuntu-24.04'
const ROOT = '/home/chronos/dsh-wsl-m0/fs-test'

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}
const codeOf = async (fn) => {
  try { await fn(); return 'no-error' } catch (error) { return error.code ?? String(error.message) }
}

const broker = new WslBroker({ distro: DISTRO, idleMs: 0, helperSource })
await broker.connect()
await broker.call('exec', { argv: ['/bin/bash', '-c', `rm -rf ${ROOT} && mkdir -p ${ROOT}/sub`] })

const fs = createWslFileSystem({ brokerFor: () => broker, defaultDistro: DISTRO, defaultCwd: ROOT })

// resolve / processPath / fileUrl / contains
{
  const rel = await fs.resolve('a.txt')
  ok(rel.displayPath === `${ROOT}/a.txt`, 'relative path resolves against the default cwd', rel.displayPath)
  const up = await fs.resolve('../x/./y.txt')
  ok(up.displayPath === '/home/chronos/dsh-wsl-m0/x/y.txt', '.. and . collapse lexically', up.displayPath)
  ok(fs.processPath(rel) === `${ROOT}/a.txt`, 'processPath returns the Linux path')
  ok(fs.fileUrl(rel) === `file://${ROOT}/a.txt`, 'fileUrl encodes the Linux path')
  ok(fs.contains(await fs.resolve('.'), rel), 'contains: child inside parent')
  ok(!fs.contains(rel, await fs.resolve('sub')), 'contains: sibling is not inside')
  ok(fs.processPathFromHostPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\chronos\\a.txt') === '/home/chronos/a.txt', 'UNC maps to Linux')
  ok(fs.processPathFromHostPath('C:\\Users\\Yunson\\a.txt') === '/mnt/c/Users/Yunson/a.txt', 'drive letter maps to /mnt')
}

// write / read / stat / lstat
{
  const t = await fs.resolve('a.txt')
  const outcome = await fs.writeText(t, 'hello\n', { kind: 'createIfAbsent' })
  ok(outcome.operation === 'create' && outcome.before === null, 'create with createIfAbsent')
  ok((await fs.readText(t)) === 'hello\n', 'readText returns what was written')
  const info = await fs.stat(t)
  ok(info?.type === 'file' && typeof info.version === 'string', 'stat returns a versioned file info', JSON.stringify(info))
  ok((await fs.lstat('a.txt', { cwd: ROOT }))?.type === 'file', 'lstat works on a plain path')
  ok((await fs.stat(await fs.resolve('missing.txt'))) === undefined, 'absent target stats as undefined')
  const missing = await fs.resolve('missing.txt')
  ok((await codeOf(() => fs.readText(missing))) === 'FS_NOT_FOUND', 'missing read reports FS_NOT_FOUND')
  ok((await codeOf(() => fs.writeText(t, 'x', { kind: 'createIfAbsent' }))) === 'FS_EXISTS', 'createIfAbsent refuses an existing file')
}

// version guards
{
  const t = await fs.resolve('a.txt')
  const info = await fs.stat(t)
  await fs.writeText(t, 'v2\n', { kind: 'replaceIfVersion', version: info.version })
  ok((await codeOf(() => fs.writeText(t, 'v3\n', { kind: 'replaceIfVersion', version: info.version }))) === 'FS_STALE_VERSION', 'stale replace is refused')
  ok((await codeOf(() => fs.editText(t, { oldString: 'v2', newString: 'v3' }, { version: info.version }))) === 'FS_STALE_VERSION', 'stale edit is refused')
}

// edit
{
  const t = await fs.resolve('edit.txt')
  await fs.writeText(t, 'one two two\n', { kind: 'createIfAbsent' })
  ok((await codeOf(() => fs.editText(t, { oldString: 'two', newString: 'three' }))) === 'FS_EDIT_NOT_UNIQUE', 'ambiguous edit is refused')
  const outcome = await fs.editText(t, { oldString: 'two', newString: 'three', replaceAll: true })
  ok(outcome.after === 'one three three\n', 'replaceAll edits every occurrence')
  ok((await codeOf(() => fs.editText(t, { oldString: 'nope', newString: 'x' }))) === 'FS_EDIT_NO_MATCH', 'missing oldString reports FS_EDIT_NO_MATCH')
}

// listing / delete
{
  const dir = await fs.resolve('.')
  const entries = await fs.listDir(dir)
  const names = entries.map((e) => e.name)
  ok(names.includes('a.txt') && names.includes('edit.txt') && names.includes('sub'), 'listDir returns children', names.join(','))
  ok(entries.every((e) => e.target.targetKey.startsWith(`wsl:${DISTRO}|`)), 'entries carry wsl targets')
  ok(entries.find((e) => e.name === 'sub')?.type === 'directory', 'listDir reports directory type')

  const t = await fs.resolve('a.txt')
  const removed = await fs.deleteFile(t)
  ok(removed.before === 'v2\n', 'deleteFile returns the removed text')
  ok((await codeOf(() => fs.deleteFile(t))) === 'FS_NOT_FOUND', 'second delete reports FS_NOT_FOUND')
}

// byte reads
{
  const t = await fs.resolve('bytes.bin')
  await fs.writeText(t, 'ABCDEFGHIJ', { kind: 'createIfAbsent' })
  const all = await fs.readBytes(t, undefined, 100)
  ok(Buffer.from(all).toString() === 'ABCDEFGHIJ', 'readBytes returns the content')
  const capped = await codeOf(() => fs.readBytes(t, undefined, 4))
  ok(capped === 'FS_TOO_LARGE', 'readBytes honours maxBytes')
  const window = await fs.readByteRange(t, { offset: 2, length: 3 })
  ok(Buffer.from(window).toString() === 'CDE', 'readByteRange returns the window')
}

// unsupported surfaces stay loud
{
  ok((await codeOf(() => fs.watch())) === 'FS_UNSUPPORTED', 'watch reports FS_UNSUPPORTED')
}

// patchText
{
  const t = await fs.resolve('patch.txt')
  await fs.writeText(t, 'alpha\nbeta\ngamma\n', { kind: 'createIfAbsent' })
  const outcome = await fs.patchText(t, [{ lineNumber: 2, oldLines: ['beta'], newLines: ['BETA', 'inserted'], isEndOfFile: false }])
  ok(outcome.after === 'alpha\nBETA\ninserted\ngamma\n', 'patchText applies hunks', JSON.stringify(outcome.after))
  const mismatch = await codeOf(() => fs.patchText(t, [{ lineNumber: 2, oldLines: ['nope'], newLines: ['x'], isEndOfFile: false }]))
  ok(mismatch === 'FS_PATCH_MISMATCH', 'patchText rejects a hunk that does not match', mismatch)
  const stale = await codeOf(() => fs.patchText(t, [{ lineNumber: 1, oldLines: ['alpha'], newLines: ['A'], isEndOfFile: false }], { version: '0-0' }))
  ok(stale === 'FS_STALE_VERSION', 'patchText honours the version guard', stale)
}

// moveFile
{
  const src = await fs.resolve('move-src.txt')
  const dst = await fs.resolve('move-dst.txt')
  await fs.writeText(src, 'one\ntwo\n', { kind: 'createIfAbsent' })
  const moved = await fs.moveFile(src, dst)
  ok(moved.sourceDeleted === true, 'moveFile deletes the source after publishing')
  ok((await fs.readText(dst)) === 'one\ntwo\n', 'moveFile publishes the content')
  ok((await codeOf(() => fs.readText(src))) === 'FS_NOT_FOUND', 'moveFile leaves no source')
  await fs.writeText(src, 'three\n', { kind: 'createIfAbsent' })
  const again = await fs.moveFile(src, dst, { hunks: [{ lineNumber: 1, oldLines: ['three'], newLines: ['THREE'], isEndOfFile: true }] })
  ok(again.sourceDeleted === true && (await fs.readText(dst)) === 'THREE\n', 'moveFile applies optional hunks on the way')
}

// distro dispatch: every target carries its distribution
{
  const seen = []
  const spy = createWslFileSystem({ brokerFor: (d) => { seen.push(d); return broker }, defaultDistro: '', defaultCwd: ROOT })
  const unc = await spy.resolve('.', { cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\chronos' })
  ok(unc.targetKey === `wsl:Ubuntu-24.04|/home/chronos`, 'UNC cwd selects the distro for the target', unc.targetKey)
  ok(seen.includes('Ubuntu-24.04'), 'brokerFor received the distro from the cwd', seen.join(','))
  const plain = await spy.resolve('/tmp', {})
  ok(plain.targetKey.startsWith('wsl:|'), 'a Linux-only path uses the default distro', plain.targetKey)
}

await broker.call('exec', { argv: ['/bin/bash', '-c', `rm -rf ${ROOT}`] })
await broker.disconnect('test-done')
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
