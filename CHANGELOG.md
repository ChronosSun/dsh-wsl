# Changelog

## 1.6.0

- Add `wsl_path`: read-only Linux ↔ Windows path conversion, including
  `\\wsl.localhost\<distro>\...` and `/mnt/<drive>`.
- Add `wsl_project_check`: read-only project doctor for package/lock/build
  manifests and the Linux tools they require.
- Merge the duplicated `engines` block so both Node and DSH constraints are
  declared, and widen the DSH range to `>=0.2.2-rc.1`.
- Update the market entry to `WSL World`, with the “world, not a tool set”
  positioning and the new tool documentation.

## 1.5.3

- Panel readiness card: Linux Node state with a direct **安装 Node** action and
  an explicit **检查环境** button; no automatic doctor run.
- Doctor reports kernel, init system, cgroup, docker, GPU and Windows mounts.
- Reposition the market entry as **WSL World** (not a `wsl_*` tool set), with
  comparison, security and submission documentation.

## 1.5.2

- Add GitHub `repository`/`homepage`/`bugs` metadata; publish this version after
  creating `chronosun/dsh-plugin` so npm links resolve.
- Add the format-1 market index under `market/` and a GitHub Pages workflow.

## 1.5.1

- Republish after the `@chronosun/dsh-wsl@1.5.0` upload was **staged** (the
  registry showed only the `0.0.0-stage` placeholder). No code change; use a
  token with **Read and write (publish and stage)**, not “stage only”.

## 1.5.0

- Rename the plugin from `dsh-remote-wsl` to **`@chronosun/dsh-wsl`**
  (npm rejected the unscoped `dsh-wsl` as too close to `is-wsl`). The host id,
  client id and route remain `dsh-wsl`. Existing `dsh-remote-wsl` installs must
  be removed before installing this package (same WSL preset would otherwise
  collide).
- Include the cached/preloaded panel tab bar from 1.4.11.

## 1.4.11

- Cache the last distro list/broker settings in localStorage and preload them
  when the client plugin loads, so the tab bar paints immediately when the WSL
  page opens; a skeleton tab row covers the very first run.

## 1.4.10

- Make the distro tabs match the session tabs: text-only tabs on a bottom rule,
  with the active tab in the accent color and a 2px underline. Removes the
  low-contrast pill.

## 1.4.9

- Replace the distro rows with a simple tab bar named after each distribution;
  the selected tab shows that branch's user@home, node, broker state, refcount
  and connect/disconnect action, in the style of the automation-task tabs.

## 1.4.8

- Move the workspace-path user helper into a new `src/path-user.mjs` module so
  a live upgrade does not import a named export from a cached old
  `settings.mjs` (1.4.7 failed activation with that SyntaxError).

## 1.4.7

- Remove the per-distribution user selectors. The workspace path selects the
  Linux identity (`/home/<user>`, `/root`) for the world, terminal, search and
  `@` broker; settings remains only a fallback.
- Move the long panel introduction into a `?` help button (native hover text).
- Broker status now matches the configured user and prefers a ready broker, so
  a stale root entry no longer makes Ubuntu-26.04 look detached/offline.

## 1.4.6

- Close the add-workspace distro menu on any outside pointer press or Escape,
  not only after selecting a distro.

## 1.4.5

- The add-workspace action is a dark split button: plus + label on the left,
  chevron on the right opening a distro menu; picking a distro opens the folder
  picker directly on that distro.

## 1.4.4

- Panel icon is a plain penguin outline (white body, currentColor outline,
  flippers and feet), no blue tile/background.
- The WSL panel no longer runs the doctor automatically on open; it only runs
  when the user presses 运行诊断. Host-boot non-root detection remains.

## 1.4.3

- Two-column WSL panel: settings, distributions, connections and idle timeout
  on the left; diagnostics and guided fixes on the right, using the full page
  width like the automation page.

## 1.4.2

- Larger, white-outlined penguin tile so the 20px panel header icon still reads
  as a penguin; the package icon uses the same artwork.

## 1.4.1

- Idle disconnect is configured in **days**, default **5** (persisted in
  settings); `0` still means never. Existing brokers receive the new timeout.
- A clearly recognizable WSL penguin tile for the panel and plugin icon.
- Publish metadata: public package, keywords, engines, LICENSE, no `private`.

## 1.4.0

- Never default a root distro to the root Agent: the doctor lists normal users,
  persists the first one when the current user is root, re-checks as that user,
  and the panel offers a `create user` action when the distro has none.
- The settings user field is a dropdown of detected users; the panel runs the
  doctor on open so a non-root default is applied before a Session starts.
- The terminal launcher starts as the configured distro user, not the WSL
  default root.
- Linux penguin outline for the panel and plugin icon.
- Display title is now `WSL` (package id stays `dsh-remote-wsl`).

## 1.3.6

- Exclude `.agents/worktrees/` from the WSL diff snapshot/paths so retained
  checkouts are not reported as parent gitlinks.
- `create_wsl_worktree` adds `.agents/worktrees/` to the parent
  `.git/info/exclude` so the Host recorder also ignores retained checkouts.

## 1.3.5

- Remove the obsolete `wsl-diff.mjs`/`worktree-tool.mjs` copies; the live
  modules are `wsl-diff-v2.mjs` and `worktree-tool-v2.mjs`.

## 1.3.4

- Worktree tool: when the tool context reports `cwd: "/"`, fall back to the
  Session header/workingDirectory before treating it as the workspace; the
  unit test now covers that shape.

## 1.3.3

- Worktree tool v2 module (session-header cwd fallback + diagnostics), exported
  through `./worktree`; the running preset still caches the older tool until
  DSH restarts.

## 1.3.2

- Worktree tool: resolve the Session cwd from `agent.cwd`, the Session header,
  or `workingDirectory.get`, not only `agent.cwd`.

## 1.3.1

- WSL diff recorder uses the stable `exec` helper path instead of the new git
  helper ops, so a running pre-1.2 helper still produces WSL summaries.
- Map a late `workspace/changes` seq to the WSL summary (by turn) instead of
  dropping it; expose `wslDiff.stats` (`late`, `errors`, `entries`).
- Mark WSL summaries `source: "wsl"` for live verification.

## 1.3.0

- New `wsl-diff-v2` module path to bypass the HMR module cache for the recorder.

## 1.2.0

- Add `create_wsl_worktree`: create a retained Git worktree with Linux git and
  return its path/branch/base. The Session cwd stays unchanged, so callers pass
  the path or `workdir`; the Host `create_worktree` tool is not mounted.

## 1.1.1

- Fix the settings route: exact routes are keyed by path, so GET+POST on
  `/settings` registered twice and the second replaced the first (GET returned
  405). One `*` route now dispatches both methods.
- Make the doctor's SSH-config fix idempotent: it also recognises an existing
  `ControlMaster` block, not only its own `dsh-remote-wsl` marker.

## 1.1.0 — publish readiness

- **Doctor**: read-only WSL/distro/network checks plus guided fixes for Linux
  Node, SSH keys and `~/.ssh/config`.
- **Per-distro user settings**: a panel field per distribution, used by the
  panel, the WSL preset and `@`/search brokers; a default distribution setting.
- **WSL-native `@` discovery** and **Linux diff display paths** (1.0.9).
- **Search**: `.gitignore`-aware file lists (1.0.8); login PATH minus `/mnt`
  for commands (1.0.7), keeping user toolchains reachable.
- **Model cwd**: WSL sessions present the Linux working directory while the
  Host keeps the UNC path for diff/open (1.0.6).
- **Capability report** in `/dsh-remote-wsl/state`, icon and locale metadata,
  CI workflow for the pure unit tests.

## 1.0.5 — 1.0.0

- Auto-bind the WSL preset for new sessions in a WSL workspace; route takeover
  on live reinstall; Linux cwd, clean PATH, gitignore-aware search, eval harness.
