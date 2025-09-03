# Change Log

## 0.0.4 - 2025-09-03

### Added
- Search In on file and directory nodes: opens Find in Files with the Include field prefilled.
	- File nodes use the exact relative path.
	- Directory nodes use `path/*` (immediate children only) by default.

### Changed
- Search in Group now fills only the Include field; Exclude is no longer set.
- Editor auto-reveal/focus now triggers only when the Sub Explorer view is visible (no auto-show), reducing surprise focus shifts.

### Fixed
- Restored reliable left-click open on file nodes; added a small fallback to ensure the file opens if the node command isn’t invoked.
- Further reduced flicker when switching active groups and reselecting items by suppressing programmatic selection events and re-highlighting the final node only.
- Active-group context menus now show the same actions as regular groups (Search in Group, Add Item, Rename, Copy, Delete, Group Settings, Reveal, and Checkout on mismatch).

## 0.0.3

### Added
- Setting `subExplorer.activeBehaviorEnabled` to toggle active-group behavior and editor auto-focus/reveal.
- More detailed debug logs for reveal traversal to aid diagnostics.
- Group reordering: drag-and-drop in the view and Move Group Up/Down commands, persisted in `.vscode/sub-explorer.json`.
- Search in Group command to prefill Find in Files with the group's items (non-recursive top-level, with excludes for deeper levels).

### Changed
- Reveal path now expands folders without highlighting intermediate nodes; only the final target is selected.
- Editor-driven sync uses focus: false to avoid stealing focus from the editor.

### Fixed
- Reduced flicker when clicking files across groups by awaiting active-group switch and re-selecting the clicked node.
- Avoid duplicate reveals when a selection is immediately followed by an open command (guards via recent-selection and last-open markers).
- More robust reveal on tab switch: ensure view is visible, retry selection briefly, and fallback to the owning group when the file is outside the active group.
- Improved name-mode traversal by matching both label and `basename(resourceUri)`.
- Minor stability improvements around refresh timing and throttling.

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
