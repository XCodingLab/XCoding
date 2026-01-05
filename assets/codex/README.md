# Bundled Codex (dev-only)

This folder provides a project-local `codex` binary for **development** (and is **not committed to git**).

Why:
- The IDE’s Codex panel starts the backend via `codex app-server`.
- For local development, this avoids requiring every teammate to install `codex` globally.
- During packaging (multi-platform GitHub Actions builds), the matching binary is copied into the app `resources/` directory, keeping the same directory layout.

## Directory layout

Place the binary at:

```
assets/codex/bin/<platform-arch>/<exe>
```

Where:
- `<platform-arch>` = `${process.platform}-${process.arch}`
  - Examples: `darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`
- `<exe>`:
  - macOS/Linux: `codex`
  - Windows: `codex.exe`

Example (Apple Silicon):

```
assets/codex/bin/darwin-arm64/codex
```

## One-command fetch (CI/packaging, also for local dev)

Run:

```bash
pnpm -s run setup:codex
```

This fetches the specified `codex` release binary from `openai/codex` GitHub Releases and writes it to `assets/codex/bin/<platform-arch>/`.

Version selection:
- Prefer env var `CODEX_VERSION`
- Otherwise read `assets/codex/version.txt`

If you hit GitHub API rate limits, set:

```bash
export GITHUB_TOKEN="..."
```

The script will include `Authorization: Bearer <token>` to increase your API quota.

If you need a proxy (for example, a URL-prefix proxy like `https://gh-proxy.com/`), set:

```bash
export CODEX_GH_PROXY="https://gh-proxy.com/"
```

The script will prefix GitHub API URLs and release asset download URLs as: `$CODEX_GH_PROXY + <original URL>`.

Suggested proxies (pick based on your network):
- Mainland China: `https://v6.gh-proxy.org/`
- Overseas: `https://gh-proxy.org/`

Example:

```bash
export CODEX_GH_PROXY="https://v6.gh-proxy.org/"
pnpm -s run setup:codex
```

By default, only download domains (`github.com`/`raw.githubusercontent.com`) are proxied to avoid redirect loops on `api.github.com`. To force proxying everything, set:

```bash
export CODEX_GH_PROXY_MODE="all"
```

The default proxy URL format is: `https://<proxy>/<full-url>` (e.g. `https://gh-proxy.org/https://github.com/...`). If your proxy requires a `?url=` form, set:

```bash
export CODEX_GH_PROXY_FORMAT="query"
```

> Note: Codex release tags are commonly `rust-v<version>` (e.g. `rust-v0.77.0`). The script supports both `rust-v*` and `v*` tag formats.

> Note: Binaries under this folder are ignored by `.gitignore` and will not be committed.
