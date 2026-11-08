# DSH plugin market index

This directory is a **format 1** DSH plugin-market index for
`@chronosun/dsh-wsl`. It is a static index: DSH does not have an official
central index yet, so users add this URL in **Plugins → Discover → Add index**.

## Host it

The recommended host is GitHub Pages for the repository:

```text
https://github.com/ChronosSun/dsh-wsl
```

With Pages set to **GitHub Actions**, the workflow in
`.github/workflows/pages.yml` publishes this directory, giving:

```text
https://chronossun.github.io/dsh-wsl/index.json
https://chronossun.github.io/dsh-wsl/icon.svg
```

Any HTTPS static host works; `index.json` and `icon.svg` must stay together.

## Users add it

1. Enable the **Custom plugin indexes** experimental bundle.
2. Open **Plugins → Discover**.
3. Add the index URL above.
4. Install **WSL**.

The index points at the npm version:

```text
@chronosun/dsh-wsl@1.6.1
```

## Update a release

After publishing a new npm version, update `market/index.json`:

- `plugins[0].versions[0].version`
- `plugins[0].versions[0].publishTimestamp` (Unix seconds)
- keep the `source` as `{ "type": "npm" }`

Then push `market/` to `main`; the Pages workflow redeploys.

## GitHub repository

Package metadata in `pkg/package.json` points at:

```text
https://github.com/ChronosSun/dsh-wsl
```

If your GitHub account/repository is different, update both
`pkg/package.json` and `market/index.json` before publishing a new version.

### Create the repository and topics

```powershell
cd C:\Users\Yunson\dsh-wsl-plugin
git init
git add .
git commit -m "dsh-wsl: WSL execution world for DSH"
gh repo create ChronosSun/dsh-wsl --public --source . --remote origin --push
gh repo edit ChronosSun/dsh-wsl `
  --add-topic dsh-plugin `
  --add-topic dsh `
  --add-topic wsl `
  --add-topic wsl2 `
  --add-topic deepseek-harness
```

If `gh` is not installed, create the repository on github.com and push
manually; add the same topics in the repository settings.
