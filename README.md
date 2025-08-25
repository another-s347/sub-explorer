# Sub Explorer

Focus on the parts of a giant repo that matter to your current feature. Create groups, add specific folders/files, and browse them in a compact tree. Honors VS Code sticky scroll in editors and uses normal file icons.

## Features
- Multiple groups (one per feature/initiative)
- Each group shows only the files/folders you add
- Tree view with lazy loading of included directories
- Commands to add/rename/delete groups, add/remove items
- Open and reveal items in Explorer
- Config stored in `.vscode/sub-explorer.json` per workspace

## Configuration file
`.vscode/sub-explorer.json`:
```json
{
  "groups": [
    {
      "id": "feat-abc",
      "name": "Feature ABC",
      "items": ["src/featureA", "packages/util/src/index.ts"]
    }
  ]
}
```

## Commands
- Sub Explorer: Add Group
- Sub Explorer: Rename Group
- Sub Explorer: Delete Group
- Sub Explorer: Add Item (File/Folder)
- Sub Explorer: Remove Item
- Sub Explorer: Open Item
- Sub Explorer: Reveal in Explorer
- Sub Explorer: Refresh

## Notes
- Sticky scroll is an editor feature; file tree follows VS Code defaults.
- If an included folder is huge, children are fetched lazily on expand.

