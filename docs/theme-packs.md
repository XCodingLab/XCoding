# Theme Packs

XCoding supports **Theme Packs**: each theme pack is a folder. Drop it into the app data directory and it will appear in Settings for selection.

---

## 1. Theme Directory

Theme packs live at:

```
userData/themes/
```

In the app, you can open it via **Settings → Open Themes Folder**.

---

## 2. Theme Pack Structure

Each theme pack is one folder and must contain at least `theme.json`:

```
themes/<themeId>/
  theme.json
  theme.css        # optional
  assets/          # optional (fonts/images/etc.)
```

### 2.1 `theme.json` (VS Code style)

`theme.json` follows VS Code Color Theme JSON structure (common fields: `name/type/colors/tokenColors`).
Example (minimal):

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

### 2.2 Color Mapping

Keys in `colors` are mapped to CSS variables:

- `editor.background` → `--vscode-editor-background`
- `list.activeSelectionBackground` → `--vscode-list-activeSelectionBackground`

As long as your theme uses standard VS Code `colors`, XCoding UI will override via `--vscode-*` tokens.

### 2.3 Optional: `css`

You can add a non-standard field `css` to load extra CSS (e.g. `@font-face`, fine-grained overrides):

```json
{
  "name": "My Theme",
  "type": "dark",
  "css": "theme.css",
  "colors": {}
}
```

Notes:
- Only relative paths inside the theme folder are allowed (e.g. `url("./assets/font.ttf")`)
- Remote/unsafe URLs (`http/https/data/file/javascript`, etc.) are ignored
- `@import` is stripped to prevent external resource loading

### 2.4 Optional: `cssVars`

For additional non-VSCode variables, use `cssVars`:

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

## 3. Built-in Themes

XCoding ships with a default theme pack (cannot be deleted; it will be recreated automatically if missing):
- `builtin-classic` (default)

On first initialization, XCoding also writes an editable optional theme pack under `themes/` (you can edit/delete it):
- `builtin-dark` (Aurora Dark)

---

## 4. Import via ZIP (Recommended)

Settings supports importing a `.zip` theme pack:

1. Open **Settings → Import Theme Pack**
2. Select a `.zip` file
3. If a theme with the same id already exists, you will be prompted to replace it
4. After import, the theme appears in the dropdown (you can switch immediately)

Supported zip layouts (minimal compatibility):
- **Single top-level directory (recommended)**: `<themeId>/theme.json`
- **No top-level directory**: `theme.json` at the zip root (`themeId` falls back to zip file name)

---

## 5. Quick Verification

1. Open **Settings → Open Themes Folder**, locate `userData/themes/`
2. Copy the example theme pack from `docs/examples/theme-packs/example-dark/`
3. In Settings, select the new theme and verify:
   - UI colors change immediately
   - Monaco editor theme updates
   - Terminal colors update
4. Delete the theme folder and restart / reopen Settings: the app should fall back to `builtin-classic` (no blank screen)

