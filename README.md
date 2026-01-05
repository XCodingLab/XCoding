# Xcoding IDE

Lightweight multi-project AI IDE (AI Studio style) — project skeleton (M0/M1).

Language: **English** | [简体中文](README.zh-CN.md)

## Development

1) Install dependencies:

`pnpm install`

2) Start (Vite + Electron):

`pnpm run dev`

> Note: if your environment sets `ELECTRON_RUN_AS_NODE=1`, Electron will run in Node mode and main-process APIs won’t work. This repo forces it off via `env -u ELECTRON_RUN_AS_NODE` in scripts.

## Current status (M0/M1)
- Fixed 4-column layout shell: Project Switcher / Explorer / Workspace / AI Chat (hideable)
- Built-in i18n: **English by default**, supports switching between `en-US` and `zh-CN` (no external language packs yet)
- Terminal: xterm.js + node-pty (click URLs to open a new Preview tab)
- Preview: BrowserView + Console/Network panels (basic debugging)
- AI staging: staged `fileEdits` + Apply All to disk + Revert + Diff tab (disk vs staged)
