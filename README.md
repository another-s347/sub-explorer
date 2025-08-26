# Sub Explorer

Focus on the parts of a giant repo that matter to your current feature. Create groups, add specific folders/files, and browse them in a compact tree. Honors VS Code sticky scroll in editors and uses normal file icons.

## Highlights
- Groups: create multiple groups, each showing only the files/folders you add.
- Display modes: toggle between Name and Full Path (hierarchical) via setting `subExplorer.displayMode`.
- Familiar actions: left‑click opens files; directories expand; file/dir context menus mirror Explorer (Open, Open to Side, Reveal in OS, Copy Path/Relative, Remove from Group).
- Explorer integration: right‑click files/folders in Explorer → “Add Selected to Group” (supports multi‑select).
- Group Settings: right‑click a group → “Group Settings” to rename, add/remove items, and optionally bind a Git ref (branch or commit). Buttons provide immediate feedback.
- Git binding (optional): a git ref can be bind to group, allow you to quickly switch between different branches.
- i18n: command/menu labels are localized with VS Code language packs (see `package.nls.json`).

## Settings
- `subExplorer.displayMode`: `"name"` (default) or `"fullPath"`.

## Configuration file
Config is stored per workspace in `.vscode/sub-explorer.json`.

Example:
```json
{
  "groups": [
    {
      "id": "feat-abc",
      "name": "Feature ABC",
      "items": ["src/featureA", "packages/util/src/index.ts"],
      "gitRef": "main"
    }
  ]
}
```

## Usage
1) Create a group via the + button in the Sub Explorer view or Command Palette.
2) Add items from the group’s context menu, or multi‑select in Explorer and choose “Add Selected to Group”.
3) Switch display mode in Settings if you prefer hierarchical full paths.
4) Manage a group via “Group Settings”: rename, add/remove items, optionally set/clear a Git ref.

## Notes
- Sticky scroll is an editor feature; file tree follows VS Code defaults.
- Large folders are loaded lazily when expanding.

## Vibe coding
This project is vibe coded by Visual Studio Code Copilot.