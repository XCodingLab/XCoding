# Xcoding IDE

轻量级多项目 AI IDE（AI Studio 风格）——工程骨架（M0/M1）。

[English README](README.md)

## 开发

1) 安装依赖：

`pnpm install`

2) 启动（Vite + Electron）：

`pnpm run dev`

> 注意：如果你的环境里设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 会以 Node 模式启动导致主进程 API 不可用；本项目已在脚本中通过 `env -u ELECTRON_RUN_AS_NODE` 强制解除。

## 当前实现进度（M0/M1）
- 固定四栏布局壳：Project Switcher / Explorer / Workspace / AI Chat（可隐藏）
- 内置 i18n：默认英文，支持中英切换（无语言包体系）
- 终端：xterm.js + node-pty（URL 点击新建预览 Tab）
- 预览：BrowserView + Console/Network 列表（基础排障）
- AI 暂存：fileEdits 暂存 + Apply All 写盘 + Revert + Diff Tab（磁盘 vs 暂存）

