# @chronosun/dsh-wsl

[![npm](https://img.shields.io/npm/v/@chronosun/dsh-wsl?label=npm)](https://www.npmjs.com/package/@chronosun/dsh-wsl)
[![CI](https://github.com/ChronosSun/dsh-wsl/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/ChronosSun/dsh-wsl/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@chronosun/dsh-wsl)](https://github.com/ChronosSun/dsh-wsl/blob/master/LICENSE)

**WSL World for DeepSeek Harness — a complete execution environment, not a `wsl_*` tool set.**

Run a DeepSeek Harness session inside a local WSL distribution: `bash`,
background jobs, the sidebar terminal, `read`/`write`/`edit`, `grep` and `glob`
all operate on the Linux filesystem — not on a `\\wsl.localhost` share.

The difference is architectural: the Agent does not choose between Windows and
Linux tools. The whole session world is Linux: its cwd, its PATH, its `@`
discovery, its search, its diffs and its worktree tools. There is no
`wsl-read`/`wsl-grep` tool to select, and no Windows binary hiding in `PATH`.
`wsl_path` is a narrow boundary helper for the few times a path must cross to
Windows; it does not execute anything.

## Choose this if

- your project lives in WSL, not on `/mnt/c`, and you want fast ext4 I/O;
- you want one session to stay in Linux for hours, not per-command `wsl.exe`;
- you care about native Linux `@` references, search, diffs and worktrees;
- you want the Agent to see `/home/...`, not `\\wsl.localhost\...`;
- you can install a Linux `node` in the distribution (the panel can do it).

Choose a `wsl_*` tool plugin instead if you only need to run an occasional
Linux command from a Windows session. Those tools are useful; this is a
different product.

## What it gives you

- **A WSL workspace picker.** The sidebar gains a `WSL` panel: pick a
  distribution, browse its directories, and adopt one as a workspace. The
  workspace is registered through the official API, so history, diffs and the
  session list keep working; its title is prefixed with `🐧`.
- **WSL is a workspace world, not a separate Agent mode.** The Agent-preset
  roster still shows **Standard** and **Creator**. A session created in a
  `🐧` WSL workspace maps internally to a hidden `wsl-standard` or
  `wsl-cordis` variant, keeping that mode's tools while replacing the execution
  world with WSL. The WSL cards themselves are filtered from the roster, so
  there is no third "WSL mode" to choose.
- **Global model and permissions stay global.** The variants do not declare or
  modify model intelligence, permission policy, or default settings; those
  continue to come from the profile's global configuration.
- **Persistent broker.** One broker keeps the connection per (distribution,
  user) and disconnects it after **5 idle days** by default (configurable in
  the panel, `0` = never).
- **A clean environment.** `wsl.exe` normally hands Linux a PATH polluted with
  `/mnt/c`, `/mnt/d` entries, so `node`, `npm`, `git` and `rg` can silently
  resolve to Windows binaries. Every command here runs with the distribution's
  **login PATH minus every `/mnt/*` entry**, so the user's own toolchain
  (`~/.local/bin`, cargo, nvm, `/usr/local/bin`, …) stays reachable and an
  interop binary is never used.
- **WSL-native `@` discovery.** For a WSL-world Agent, `@file` candidates are
  indexed inside the distribution (bounded tree, `.gitignore`-aware) and
  returned relative to the Linux cwd, not scanned through the UNC share. The
  Host provider remains for every other preset.
- **Linux diff summaries and comparisons.** For a WSL-world Session the plugin
  snapshots the work tree inside the distribution at turn start/end (private
  `GIT_INDEX_FILE`, `write-tree`/`diff-tree`) and serves the changed-files card
  from Linux git. The Host recorder remains the event source and fallback; the
  card's open action still uses the Host's UNC coordinates. Absolute UNC display
  paths are translated to Linux; relative paths are already neutral.
- **Linux-native worktree creation.** `create_wsl_worktree` creates a retained
  Git worktree with Linux git and returns its path, branch and base commit.
  The Session working directory is unchanged, so pass the returned path (or
  `workdir`) to later tools; the shipped Host `create_worktree` tool is not
  mounted in the WSL variants.
- **Path conversion for the boundary.** `wsl_path` converts a Linux path to
  `/mnt/<drive>` / `\\wsl.localhost\<distro>\...` and back. It is read-only and
  useful when an interop executable needs the Windows form.
- **Read-only project doctor.** `wsl_project_check` inspects a directory for
  `package.json`, lockfiles, `.nvmrc`, `Cargo.toml`, `go.mod`, `pyproject.toml`,
  `requirements.txt`, `Dockerfile`, `Makefile` and `CMakeLists.txt`, then lists
  the tools they need and what is missing in the distribution.
- **Dry-run bootstrap.** `wsl_bootstrap` plans (and only with `dryRun: false`
  installs) `node`, `python`, `build` or `tools` recipes as root inside the
  distribution. It never installs silently.
- **Persistent PTY shell for the Agent.** `wsl_term` keeps one real terminal
  shell per Agent session: `run` executes in the same shell (`cd`, exported
  variables and background work persist), `read` returns buffered output,
  `input` writes raw keystrokes for TUI/REPL programs, `resize` changes the PTY
  size, `interrupt` sends SIGINT, and `close` ends it.

## Why this instead of opening the UNC path

Opening `\\wsl.localhost\...` as a Workspace only changes the folder: on Windows
the standard preset still runs `pwsh`, reads and writes through the 9P share,
and spawns the Windows `rg`. This bundle changes the **execution world**:

| | UNC workspace | WSL workspace |
|---|---|---|
| shell | Windows `pwsh` | Linux `bash`, clean login PATH |
| file I/O | 9P share | persistent broker → ext4 |
| search | Windows ripgrep over 9P | Linux walk / `git ls-files` |
| model cwd | UNC (`\\wsl.localhost\...`) | `/home/...` |
| toolchain | Windows node/npm/git | the distribution's own |

Measured on a local machine (1000 `stat`, 20 `readdir`): 9P 1.31 ms vs broker
0.29 ms per stat (4.5×), 4.48 ms vs 0.49 ms per readdir (9.1×). A cold
`wsl.exe` is about 120 ms, which is why file and search work go through the
persistent broker while `bash` keeps DSH's one-shot contract (`workdir`, not a
persistent `cd`).

It is deliberately not a host-preset rewrite and not a `wsl_*` tool set. The
world is delivered as hidden WSL variants of the visible Standard/Creator
modes, so the model never chooses between Windows and Linux tools and no extra
WSL mode card appears.

## Compared with `wsl_*` tool plugins

| | `dsh-wsl-tool` style | this plugin |
|---|---|---|
| Unit of change | ten tools added to any session | the whole session world |
| Model cwd | Windows cwd, explicit `workdir` per call | Linux cwd for the session |
| `@`, search, diffs | host/9P, plus tool-specific substitutes | Linux-native |
| PATH | Windows PATH can leak in; doctor detects it | login PATH minus `/mnt/*` |
| Per-command cost | fresh `wsl.exe` each call | persistent broker |
| Terminal | agent-driven `wsl-term` | user sidebar terminal |
| Setup | one command, any preset | WSL workspace (mode inherited) |

The two are complementary in spirit but not usually installed together: if you
already run a Windows session and only need occasional WSL commands, the tool
plugin is the lower-friction choice. If the project lives in WSL, this world is
the lower-friction choice after the one-time workspace setup.

## Install

Published package:

```powershell
dsh plugin --profile desktop add @chronosun/dsh-wsl
```

From a source checkout:

```powershell
npm pack --pack-destination dist
dsh plugin --profile desktop add dist\chronosun-dsh-wsl-<version>.tgz
```

Then **quit DSH from the tray and reopen it** — client plugins and preset rows
load at boot; a page refresh is not enough.

> Run the `dsh plugin` command from a **Windows directory** (`C:\Users\...`),
> not from a `\\wsl.localhost\...` current directory: the CLI is a Windows
> `cmd` launcher and cannot start from a UNC path.

If you are migrating from `dsh-remote-wsl`, remove its old `terminal-controller`
patch or update its `terminal-launcher.mjs` path to
`...\node_modules\@chronosun\dsh-wsl\terminal-launcher.mjs`; the old package
directory no longer exists after the dependency change.

Requires: Windows, WSL 2, and a Linux `node` (v18+) inside the distribution,
used only to run a small helper. Nothing is installed into the distribution.

## Use

1. Sidebar → `WSL` → `＋ 添加 WSL 工作区`.
2. Choose a distribution, browse to a directory, press `使用此目录`.
3. The workspace opens in the WSL execution world. There is no separate
   `WSL` mode card: a new session maps to the hidden WSL variant of the current
   global Agent mode (Standard or Creator), so its tools and the global
   model/permission settings are inherited. In a WSL session the Agent's
   `Current working directory` is the Linux path (the Host still keeps the UNC
   path for its own diff/`@` features). Ask the agent to run
   `pwd; uname -s; echo $PATH` and it should answer `/home/..., Linux` and a
   five-entry PATH.
4. `标记已有` renames existing `\\wsl.localhost\...` workspaces with the `🐧`
   prefix; workspaces that already carry it are skipped and the panel reports
   how many changed. Renaming is only cosmetic — the preset default keys off
   the path, so an unmarked WSL workspace still gets `WSL` sessions.

## Limits (deliberate, documented)

- `watch` is not implemented by the WSL filesystem, so the skill catalog is
  collected once (`watch: false`) instead of being invalidated live.
- The Host keeps the durable session cwd as the UNC path, because host
  features (diff view, `@` references, open-in-app) resolve it through the
  Windows filesystem. WSL-world sessions present the **Linux** equivalent as
  `Current working directory` to the Agent, so every model-visible path is
  Linux; every tool still accepts either form.
- A WSL snapshot companion serves the changed-files summary/comparison for WSL
  Sessions; the Host recorder still runs as the `workspace/changes` event
  source and fallback. When the WSL snapshot misses the event race, the card
  falls back to the Host summary. Open coordinates (`path`/`cwd`) stay UNC.
- A filesystem target carries its own distribution, so workspaces from several
  distributions coexist; a call with a Linux-only path falls back to the
  distribution the world was configured with.
- `grep` uses a JavaScript regular expression and skips files over 2 MiB;
  `glob`/`grep` require an explicit `path`. Inside a Git worktree both respect
  `.gitignore` (they list files with `git ls-files --exclude-standard`), so
  `build/`, `dist/` and ignored dependency trees are not searched; outside a
  worktree the walk prunes `.git`/`node_modules`.

## SSH and web

- `ssh`, `scp`, `rsync` and `curl` are the distribution's own binaries; keys
  and `~/.ssh/config` belong to the distribution user, not to Windows. The
  Agent has no TTY, so use key-based auth (`ssh -o BatchMode=yes host 'cmd'`)
  or `ControlMaster` for reuse; interactive password logins belong in the
  sidebar terminal. A `Host *` block with `ControlMaster auto`,
  `ControlPath ~/.ssh/cm-%r@%h:%p` and `ControlPersist 10m` makes one-shot
  Agent commands reuse a single connection.
- `web_fetch` / `web_search` run on the Host but share the network. A service
  started inside the distribution is reachable from Windows at
  `http://localhost:<port>` (WSL2 localhost forwarding), so both the web tools
  and `curl` work; use `curl` in `bash` when the service is reachable only
  through an SSH tunnel.

## Doctor and settings

The `WSL` panel has a readiness card (**检查环境**) and the full **运行诊断**:
it checks the WSL version, each distribution's user/home, Linux `node`, `git`,
`ssh`, SSH keys, `~/.ssh/config`, kernel/systemd/cgroup, docker/GPU availability,
the login PATH and how many `/mnt` entries the plugin has to remove, plus
`.wslconfig` networking mode and localhost forwarding. If Linux Node is missing,
the readiness card offers **安装 Node** directly; the full doctor also offers
guided actions:

- **安装 Node** — `apt-get install nodejs` as the distro user (uses `sudo -n`;
  refuses without passwordless sudo and prints the command instead);
- **生成 SSH key** — `ssh-keygen -t ed25519` with no passphrase, then shows the
  public key to add to devices;
- **写 SSH 配置** — appends a `ControlMaster`/`ControlPersist` block once;
- **创建普通用户** — when a distro's default user is `root` and it has no normal
  user, creates `chronos` (locked password, home, bash).

Settings store a **default distribution** and a **per-distribution login user**
in `~/.dsh/remote-wsl-settings.json`. The user is normally derived from the
workspace path (`/home/<user>/...` or `/root`), so the panel does not ask again
when you add a workspace; the doctor reports the users it finds and a root
distro is automatically moved to its first normal user when settings are empty.
The terminal, WSL variants and `@` index all use that user, so a Session and its
terminal run as the same non-root identity.

The panel and plugin icon are a penguin outline (white body, current-color
outline, no blue tile); the sidebar title is `WSL` and the market title is
`WSL World`, package id `@chronosun/dsh-wsl`.

## Security boundary

- Commands and file writes run as the configured Linux user inside the
  distribution. This plugin does not provide a root mode.
- The broker is a local child process; the plugin does not send telemetry or
  make network requests of its own.
- A workspace grants the Agent the same access that user has in the
  distribution. Use a normal user, review the doctor, and keep secrets out of
  paths the Agent can read.
- The Host still keeps the durable session cwd as a UNC path for its own
  file-tree/diff features; model-visible paths are Linux. This is a
  compatibility bridge, not a security boundary.

## Development

From `pkg/`:

```bash
npm test                      # pure unit tests (no WSL required)
DSH_WSL_INTEGRATION=1 npm test # + real WSL broker tests
npm run check                 # release contract: client id, exports, market
```

`npm run check` fails if the client bundle id differs from the package name
(the 1.7.1 boot-crash class), if a Cordis subpath is not exported, or if the
market entry version disagrees with `package.json`.

## Compatibility

| DSH | Status |
|---|---|
| `0.2.2-rc.1` | tested (unit + real WSL + Agent A/B eval) |
| other `0.2.x` | capability-probed, untested |

The Host seam is narrow: `sessionController.create`, `workingDirectory.contextText`,
`fileReferences.list`, `workspaceChanges.summary/diff`, plus the web server.
Each patch checks the service/method and degrades independently; `/dsh-wsl/state`
reports `capabilities` so a missing seam is visible instead of taking the whole
plugin down. The WSL variants themselves use only published Cordis services.

## Verifying a live install

From the source checkout, after restarting DSH to load the current profile:

```sh
node tools/verify-live.mjs
```

It checks the installed Host version, the `wslDiff` install flag, all
capabilities, the doctor's Node/PATH result for every distro, and the settings
endpoint. Worktree creation and the panel render are manual: open a new WSL
session and call `create_wsl_worktree`, then open the WSL panel's Doctor /
Settings section.

## Troubleshooting

- **`WSL 发行版里没有 node`** — the distribution has no Linux Node.js (the
  Windows `node.exe` on `/mnt/...` does not count and is rejected). Install it
  inside the distribution, then press `断开` → `连接` in the panel:
  `sudo apt-get update && sudo apt-get install -y nodejs` (Ubuntu/Debian), or
  put a v18+ `node` on the login-shell `PATH` (`bash -lc 'command -v node'`).
  The broker caches the resolved path in `~/.dsh/wsl-broker-cache.json` and
  self-heals once when that path goes stale.
- **New Session still opens in Standard/PTC instead of WSL** — the profile was
  started before this version: the preset default is installed by the Host row
  at boot. Restart DSH (tray → quit), or check the `WSL` panel: it says when
  the default injection is not installed.
- **Agent still sees a `\\wsl.localhost\...` working directory** — `/dsh-wsl/state`
  should report `modelCwd.installed: true`. If it is missing, this build
  predates 1.0.6 or the Host row was not reloaded: restart DSH. The durable
  session cwd is intentionally still UNC for the Host's diff/`@` features.
- **`npm` / `cargo` / compiler not found in a WSL session** — commands inherit
  the distribution login PATH with `/mnt/*` removed. If a tool lives in a
  directory your login shell does not export, add it to `~/.profile` (or
  `~/.bash_profile`), then reconnect. The pre-broker fallback also includes
  `~/.local/bin`, `~/.cargo/bin` and `~/.hermes/node/bin`.
- **No `WSL` entry in the sidebar** — the bundle is installed but the client
  half was not scanned; reinstall from a tarball (`remove_bundle` →
  `install_bundle`) and restart.
- **`agent-preset/invalid: <row> (<package>): ...`** — one preset row failed to
  activate; the message names the exact service, usually a missing `isolate`
  entry on the `wsl-world` group.
- **`Receiver must be an instance of class ...`** — a provider used `#private`
  members; Cordis' service proxy calls methods with a different `this`.
- **`wsl-exec: line 1: exec: : not found`** — `wsl.exe` drops trailing
  arguments; commands must travel inside a single `-c` script.
- **`syntax error near unexpected token '('`** — `wsl.exe` pre-expands `$VAR`
  in its command line against the dirty target environment; commands are
  base64-encoded to avoid it. Quote variables in commands you write yourself.

## Market and feedback

DSH has no official central index. Add this source in **Plugins → Discover**:

```text
https://chronossun.github.io/dsh-wsl/index.json
```

Source, issues and the market index live at
<https://github.com/ChronosSun/dsh-wsl>. Please include the DSH version, WSL
version and the Doctor output when reporting a failure.

Set `DSH_WSL_DEBUG=1` to append provider traces to
`wsl-world.log` beside this package's source.
