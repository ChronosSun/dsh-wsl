# dsh-wsl

WSL execution world for DeepSeek Harness: one DSH session runs its bash,
filesystem tools, terminal, search and `@` references inside a local WSL
distribution — Linux paths, Linux tools, no Windows/9P indirection.

- npm: `@chronosun/dsh-wsl`
- plugin-market index: `https://chronossun.github.io/dsh-wsl/index.json`
- package source: [`pkg/`](pkg/)
- market index source: [`market/`](market/)

## Install

```powershell
dsh plugin --profile desktop add @chronosun/dsh-wsl
```

Then quit DSH from the tray and reopen it. The WSL panel appears in the
sidebar; create a workspace from a directory inside a distribution.

Requirements: Windows, WSL 2, and a Linux Node.js in the distribution (the
doctor can install it), plus an optional non-root user. The plugin does not
install anything into the distribution by default.

## Market

DSH currently has no official central index. Host `market/` on GitHub Pages
(see [`market/README.md`](market/README.md)), then users enable **Custom plugin
indexes** and add:

```text
https://chronossun.github.io/dsh-wsl/index.json
```

## Development

```powershell
cd pkg
npm pack
```

The package tests are under [`pkg/test/`](pkg/test/). GitHub Actions runs the
pure unit tests; WSL integration tests require Windows + WSL.

## License

MIT
