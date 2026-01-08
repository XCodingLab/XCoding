# 主题包（Theme Packs）

本项目支持“主题包”机制：一个主题包对应一个文件夹，放入应用数据目录后即可在设置中下拉选择并生效。

---

## 1. 主题目录位置

主题包目录位于：

```
userData/themes/
```

在应用内可通过 **设置 → 打开主题目录** 按钮直接打开该目录。

---

## 2. 主题包结构

每个主题包一个文件夹，至少包含 `theme.json`：

```
themes/<themeId>/
  theme.json
  theme.css        # 可选
  assets/          # 可选（字体/图片等）
```

### 2.1 `theme.json`（VS Code 风格）

`theme.json` 采用 VS Code Color Theme 的 JSON 结构（常见字段：`name/type/colors/tokenColors`）。
示例（最小示例，仅展示关键字段）：

```json
{
  "name": "My Theme",
  "type": "dark",
  "colors": {
    "editor.background": "#0b1220",
    "editor.foreground": "#e5e7eb",
    "terminal.background": "#0b1220",
    "terminal.foreground": "#e5e7eb"
  }
}
```

### 2.2 颜色映射规则

`colors` 中的键会自动映射为 CSS Variables：

- `editor.background` → `--vscode-editor-background`
- `list.activeSelectionBackground` → `--vscode-list-activeSelectionBackground`

也就是说，只要你的主题是标准 VS Code 的 `colors` 字段，本项目 UI 会按 `--vscode-*` Token 进行覆盖。

### 2.3 可选字段：`css`

你可以在 `theme.json` 中添加非 VS Code 标准字段 `css`，用于加载额外 CSS（例如 `@font-face` / 细节覆盖）：

```json
{
  "name": "My Theme",
  "type": "dark",
  "css": "theme.css",
  "colors": {}
}
```

注意：
- 只允许引用主题目录内部的相对路径资源（例如 `url("./assets/font.ttf")`）
- 远程/危险 URL（`http/https/data/file/javascript` 等）会被忽略
- 为避免主题包拉取外部资源，`@import` 会被移除

### 2.4 可选字段：`cssVars`

如需覆盖非 VS Code 的额外变量，可使用 `cssVars`：

```json
{
  "name": "My Theme",
  "type": "dark",
  "cssVars": {
    "--xcoding-font-family": "\"FiraCode Nerd Font\", ui-monospace, monospace",
    "--xcoding-icon-ts": "#60a5fa"
  },
  "colors": {}
}
```

---

## 3. 内置主题

应用内置两个主题包（无需在 `themes/` 目录中存在）：
- `builtin-dark`
- `builtin-light`

---

## 4. 通过 ZIP 导入（推荐）

设置页支持直接导入 `.zip` 主题包：

1. 打开 **设置 → 导入主题包**
2. 选择一个 `.zip` 文件
3. 如检测到同名主题目录，应用会提示是否覆盖
4. 导入成功后，主题会出现在下拉列表中（可选择立即切换）

支持的 zip 结构（最小兼容）：
- **单顶层目录（推荐）**：`<themeId>/theme.json`
- **无顶层目录**：`theme.json` 位于 zip 根部（`themeId` 取 zip 文件名）

---

## 5. 快速验证步骤（建议）

1. 打开 **设置 → 打开主题目录**，定位到 `userData/themes/`
2. 将示例主题复制进去（仓库内示例：`docs/examples/theme-packs/example-dark/`）
3. 回到设置页，在“主题”下拉选择新主题并观察：
   - UI 配色即时变化
   - Monaco 编辑器主题即时变化
   - Terminal 颜色即时变化
4. 删除该主题目录后重启/重新打开设置，应用应自动回退到 `builtin-dark`/`builtin-light`（不应白屏）
