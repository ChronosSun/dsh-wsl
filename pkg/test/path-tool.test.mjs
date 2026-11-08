import assert from 'node:assert/strict'
import { convertPath } from '../path-tool.mjs'

assert.deepEqual(convertPath('C:\\Users\\me\\a.txt', 'Ubuntu-26.04'), {
  input: 'C:\\Users\\me\\a.txt',
  linux: '/mnt/c/Users/me/a.txt',
  windows: 'C:\\Users\\me\\a.txt',
  distro: 'Ubuntu-26.04',
})

assert.deepEqual(convertPath('\\\\wsl.localhost\\Ubuntu-26.04\\home\\chronos\\x', ''), {
  input: '\\\\wsl.localhost\\Ubuntu-26.04\\home\\chronos\\x',
  linux: '/home/chronos/x',
  windows: '\\\\wsl.localhost\\Ubuntu-26.04\\home\\chronos\\x',
  distro: 'Ubuntu-26.04',
})

assert.deepEqual(convertPath('/home/chronos/x', 'Ubuntu-26.04'), {
  input: '/home/chronos/x',
  linux: '/home/chronos/x',
  windows: '\\\\wsl.localhost\\Ubuntu-26.04\\home\\chronos\\x',
  distro: 'Ubuntu-26.04',
})

assert.equal(convertPath('/mnt/d/project', 'Ubuntu-26.04').windows, 'D:\\project')
assert.throws(() => convertPath('not-a-path', 'Ubuntu-26.04'), /expected a Linux absolute path/)

console.log('path-tool: ok')
