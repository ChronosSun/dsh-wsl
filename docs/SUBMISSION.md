# Submission copy

Use this when listing `@chronosun/dsh-wsl` in a third-party DSH index or the
community directory.

## One-line pitch

> WSL World for DSH: the whole session runs in WSL — Linux cwd, clean PATH,
> native `@`/search/diffs/worktrees. Not a `wsl_*` tool set.

## Package data

```json
{
  "name": "@chronosun/dsh-wsl",
  "version": "1.8.1",
  "repository": "https://github.com/ChronosSun/dsh-wsl",
  "directory": "pkg",
  "homepage": "https://github.com/ChronosSun/dsh-wsl#readme",
  "npm": "https://www.npmjs.com/package/@chronosun/dsh-wsl",
  "index": "https://chronossun.github.io/dsh-wsl/index.json",
  "icon": "https://chronossun.github.io/dsh-wsl/icon.svg",
  "engines": { "dsh": "^0.2.2-rc.1" }
}
```

## GitHub topics

In the repository **About** settings, add:

```text
dsh-plugin
dsh
deepseek-harness
wsl
wsl2
ubuntu
ai-agent
coding-agent
```

Or with `gh`:

```bash
gh repo edit ChronosSun/dsh-wsl \
  --description "WSL World for DeepSeek Harness: a complete Linux execution world, not a wsl_* tool set." \
  --homepage "https://www.npmjs.com/package/@chronosun/dsh-wsl" \
  --add-topic dsh-plugin \
  --add-topic dsh \
  --add-topic deepseek-harness \
  --add-topic wsl \
  --add-topic wsl2 \
  --add-topic ubuntu \
  --add-topic ai-agent \
  --add-topic coding-agent
```

## PR / issue text

```text
Add @chronosun/dsh-wsl 1.8.1 to the WSL category.

npm: https://www.npmjs.com/package/@chronosun/dsh-wsl
repo: https://github.com/ChronosSun/dsh-wsl
index: https://chronossun.github.io/dsh-wsl/index.json

WSL World runs the whole DSH session in a WSL distribution: Linux cwd,
login PATH without /mnt, native @/search/diff/worktree, a persistent
broker, and a connection/doctor panel. It is a full execution world,
not a wsl_* tool set.

Requires DSH ^0.2.2-rc.1, Windows + WSL 2, and Linux Node in the distro
(the panel can install it). MIT.
```

## Where to submit

- `https://github.com/dsh-market/dsh-market/issues` — dsh.so index / market
  metadata. Check the repository's current submission instructions first.
- `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin` — community
  directory. Add a line under the WSL/Windows section and open a PR.
- Any other index owner: add the same entry to their `plugins` array and open
  a PR; do not mass-open identical issues.

No official central DSH index exists yet. The index URL above is this project's
own source; being listed elsewhere requires that index's maintainer to copy the
entry.
