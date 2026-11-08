/**
 * A workspace under `/home/<user>` (or `/root`) names its Linux user; that is
 * the identity the broker/terminal/session should use, independent of the
 * distro's default user. Kept in its own module so live upgrades cannot hit an
 * older cached `settings.mjs` without the named export.
 */
export function userFromLinuxPath(linuxPath) {
  const value = String(linuxPath ?? '')
  const home = /^\/home\/([^/]+)(?:\/|$)/.exec(value)
  if (home) return home[1]
  if (/^\/root(?:\/|$)/.test(value)) return 'root'
  return ''
}
