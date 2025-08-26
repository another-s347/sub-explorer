# Change Log

## 0.0.2

### Added
- Display mode setting `subExplorer.displayMode` with hierarchical Full Path mode.
- Explorer context menu: Add Selected to Group (supports multi-select).
- Left-click open on file nodes; context menus for files/dirs include Open to Side, Reveal in OS, Copy Path/Relative, and Remove from Group.
- View title “Add Group” button.
- Group Settings webview to rename group, add/remove items, and set/clear a Git ref (branch or commit), with immediate button feedback and toasts.
- Git binding for groups; group node shows bound ref; inline and context “Checkout Group Ref” action when current branch mismatches.
- Copy Group command.
- Localization (i18n) for command/menu titles and key notifications via `package.nls.json` and `vscode.l10n`.
- Config schema: `gitRef` field added to groups in `.vscode/sub-explorer.json`.

### Changed
- Simplified view UI: removed hover inline actions; consolidated actions into context menus; group menus always available; checkout only shown on ref mismatch.
- Full-path mode renders hierarchical segments using synthetic path nodes for clarity.
- Double-click rename refined to reduce accidental triggers (selection-only, ~300ms window).
- Checkout flow hardened: Git API usage with repo selection, falling back to built-in Git command and integrated terminal.

### Fixed
- Robust argument handling in checkout command (avoid calling `trim` on non-strings).
- Avoid assigning to read-only `TreeItem.resourceUri`.
- Corrected manifest menu conditions and JSON structure in earlier revisions.
- General stability and refresh behavior on config or filesystem changes.

## 0.0.1
- Initial preview: groups with selected files/folders in a tree view
