// Bundle entry: the patch mounts a row named after this package, which is how
// the client scanner discovers `dsh.client` and how the panel's host routes
// come up. The WSL execution world lives in ./world.js and is mounted by the
// preset instead.
export { name, inject, apply } from './host.js'
