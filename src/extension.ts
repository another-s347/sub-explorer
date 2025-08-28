import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { SubExplorerProvider, SubExplorerNode } from './tree';
import { GroupConfig, SubExplorerConfig, loadConfig, saveConfig, toRelPath, toFsUri } from './config';

export async function activate(context: vscode.ExtensionContext) {
    const provider = new SubExplorerProvider(context);
    // Suppress selection side-effects when selection is caused by programmatic reveal (e.g., editor sync)
    let suppressSelectionEffects = false;
    const isActiveBehaviorEnabled = () => vscode.workspace.getConfiguration('subExplorer').get<boolean>('activeBehaviorEnabled', true);
    // Marker to detect editor activations that originate from Sub Explorer opens (avoid double reveal/focus flicker)
    let lastUserOpen: { uri: vscode.Uri; ts: number } | undefined;
    // Track the most recent tree selection time to avoid double-handling (selection + command)
    let lastSelection: { uri?: vscode.Uri; ts: number } | undefined;

    // Drag & Drop controller to reorder groups
    class GroupDnDController implements vscode.TreeDragAndDropController<SubExplorerNode> {
        public readonly dragMimeTypes = ['application/vnd.sub-explorer.group'];
        public readonly dropMimeTypes = ['application/vnd.sub-explorer.group'];
        constructor(private readonly ctx: vscode.ExtensionContext) { }
        async handleDrag(source: readonly SubExplorerNode[], dataTransfer: vscode.DataTransfer): Promise<void> {
            const groups = source.filter(n => n.type === 'group' && n.groupId).map(n => n.groupId!) as string[];
            if (!groups.length) return;
            dataTransfer.set('application/vnd.sub-explorer.group', new vscode.DataTransferItem(JSON.stringify(groups)));
        }
        async handleDrop(target: SubExplorerNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
            const item = dataTransfer.get('application/vnd.sub-explorer.group');
            if (!item) return;
            let draggedIds: string[] = [];
            try { draggedIds = JSON.parse(await item.asString()); } catch { return; }
            if (!draggedIds.length) return;
            // Only support dropping onto group area or a group node
            if (target && target.type !== 'group') return;
            const cfg = await loadConfig();
            if (!cfg.groups.length) return;
            const targetId = target?.groupId;
            // Remove dragged from list preserving order of remaining
            const remaining = cfg.groups.filter(g => !draggedIds.includes(g.id));
            // Insert dragged before target (or at end if no target)
            const draggedGroups = cfg.groups.filter(g => draggedIds.includes(g.id));
            if (!draggedGroups.length) return;
            let insertIdx = (targetId ? remaining.findIndex(g => g.id === targetId) : -1);
            if (insertIdx < 0) insertIdx = remaining.length;
            remaining.splice(insertIdx, 0, ...draggedGroups);
            cfg.groups = remaining;
            await saveConfig(cfg);
            await provider.refresh();
        }
        dispose() { /* no-op */ }
    }

    const dnd = new GroupDnDController(context);
    const treeView = vscode.window.createTreeView('subExplorerView', { treeDataProvider: provider, showCollapseAll: true, canSelectMany: true, dragAndDropController: dnd });
    context.subscriptions.push(treeView, dnd);

    // React to runtime toggle of active behavior
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('subExplorer.activeBehaviorEnabled')) {
            if (!isActiveBehaviorEnabled()) {
                // Clear active group so UI loses 'active' marker and collapse behavior
                provider.setActiveGroup(undefined);
            }
        }
    }));

    // Double-click on a group to rename: consider selection and expand/collapse events
    let lastGroupClick: { id?: string; time?: number } = {};
    const handleGroupInteraction = async (node?: SubExplorerNode) => {
        if (!node || node.type !== 'group' || !node.groupId) { return; }
        const now = Date.now();
        if (lastGroupClick.id === node.groupId && typeof lastGroupClick.time === 'number' && (now - lastGroupClick.time) < 300) {
            lastGroupClick = {};
            await vscode.commands.executeCommand('subExplorer.renameGroup', node);
            return;
        }
        lastGroupClick = { id: node.groupId, time: now };
        setTimeout(() => { if (lastGroupClick.id === node.groupId) { lastGroupClick = {}; } }, 350);
    };
    context.subscriptions.push(treeView.onDidChangeSelection(async (e) => {
        if (!e.selection || e.selection.length !== 1) { return; }
        const node = e.selection[0] as SubExplorerNode;
        // Handle group double-click rename logic
        await handleGroupInteraction(node);
        if (suppressSelectionEffects) {
            return; // ignore programmatic selection from editor-sync reveal
        }
        lastSelection = { uri: node?.resourceUri, ts: Date.now() };
        // If any node inside a group is selected (file or directory/path/item), set that group active
        if (isActiveBehaviorEnabled() && node && node.type !== 'group' && node.groupId) {
            const current = provider.getActiveGroupId();
            if (current !== node.groupId) {
                // Switch active group, then re-select the clicked node to avoid flicker losing selection
                suppressSelectionEffects = true;
                try {
                    await provider.setActiveGroup(node.groupId);
                    // Small wait to let children recalc
                    await new Promise(res => setTimeout(res, 50));
                    if (node.resourceUri) {
                        const leaf = await provider.revealInActiveGroup(node.resourceUri, treeView, { focus: false, selectFinal: true, groupId: node.groupId });
                        if (leaf) {
                            try { await treeView.reveal(leaf, { select: true, focus: false, expand: true }); } catch { /* ignore */ }
                        }
                    }
                } finally {
                    setTimeout(() => { suppressSelectionEffects = false; }, 150);
                }
                return;
            }
        }
    }));
    // Note: we intentionally do NOT use expand/collapse events for double-click detection
    // to avoid single-click expand being misinterpreted as a double-click.

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.refresh', () => provider.refresh()));

    // Active group commands
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.setActiveGroup', async (node?: SubExplorerNode) => {
        if (!node || node.type !== 'group' || !node.groupId) return;
        provider.setActiveGroup(node.groupId);
        const uri = vscode.window.activeTextEditor?.document?.uri;
        if (uri && (uri.scheme === 'file' || uri.scheme === 'vscode-remote')) {
            await provider.revealInActiveGroup(uri, treeView);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.clearActiveGroup', async () => {
        provider.setActiveGroup(undefined);
    }));

    // On editor change: only reveal under the current active group (no auto-activation)
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (ed) => {
        if (!isActiveBehaviorEnabled()) return;
        const uri = ed?.document?.uri;
        if (!uri || (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote')) return;
        // If this activation is immediately after we opened from Sub Explorer, skip auto-reveal
        if (lastUserOpen && lastUserOpen.uri.toString() === uri.toString() && (Date.now() - lastUserOpen.ts) < 800) {
            lastUserOpen = undefined;
            return;
        }
        suppressSelectionEffects = true;
        try {
            // Ensure the Sub Explorer view is visible so selection/highlight is shown
            if (!treeView.visible) {
                try { await vscode.commands.executeCommand('workbench.view.extension.subExplorer'); } catch { /* ignore */ }
            }
            let leaf = await provider.revealInActiveGroup(uri, treeView, { focus: false, selectFinal: true });
            if (!leaf) {
                // If not found under active group, try revealing under the file's owning group (do not change active)
                const gid = provider.findGroupIdForUri(uri, provider.getActiveGroupId());
                if (gid && gid !== provider.getActiveGroupId()) {
                    leaf = await provider.revealInActiveGroup(uri, treeView, { focus: false, selectFinal: true, groupId: gid });
                }
            }
            if (leaf) {
                // Retry a couple of times in case the first selection is ignored due to render timing
                for (let i = 0; i < 2; i++) {
                    await new Promise(res => setTimeout(res, 100));
                    try { await treeView.reveal(leaf, { select: true, focus: false, expand: true }); } catch { /* ignore */ }
                }
            }
        } finally {
            // Delay to allow selection event(s) from reveal to propagate before re-enabling
            setTimeout(() => { suppressSelectionEffects = false; }, 350);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.addGroup', async () => {
        const name = await vscode.window.showInputBox({ prompt: 'Group name' });
        if (!name) return;
        const cfg = await loadConfig();
        const newGroup: GroupConfig = { id: uuidv4(), name, items: [] };
        cfg.groups.push(newGroup);
        await saveConfig(cfg);
        await provider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.renameGroup', async (node?: SubExplorerNode) => {
        const cfg = await loadConfig();
        const group = await pickGroupFromNodeOrQuickPick(cfg, node);
        if (!group) return;
        const name = await vscode.window.showInputBox({ prompt: 'New group name', value: group.name });
        if (!name) return;
        group.name = name;
        await saveConfig(cfg);
        await provider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.deleteGroup', async (node?: SubExplorerNode) => {
        const cfg = await loadConfig();
        const group = await pickGroupFromNodeOrQuickPick(cfg, node);
        if (!group) return;
        const ok = await vscode.window.showWarningMessage(`Delete group "${group.name}"?`, { modal: true }, 'Delete');
        if (ok !== 'Delete') return;
        cfg.groups = cfg.groups.filter(g => g.id !== group.id);
        await saveConfig(cfg);
        await provider.refresh();
    }));

    // Copy group: duplicates the selected group with a new name
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.copyGroup', async (node?: SubExplorerNode) => {
        const cfg = await loadConfig();
        const group = await pickGroupFromNodeOrQuickPick(cfg, node);
        if (!group) return;
        const defaultName = `Copy of ${group.name}`;
        const name = await vscode.window.showInputBox({ prompt: 'New group name', value: defaultName });
        if (!name) return;
        const newGroup: GroupConfig = { id: uuidv4(), name, items: [...group.items] };
        cfg.groups.push(newGroup);
        await saveConfig(cfg);
        await provider.refresh();
        vscode.window.showInformationMessage(vscode.l10n.t('Group "{0}" copied to "{1}".', group.name, name));
    }));

    // Move group up/down
    const moveGroup = async (node: SubExplorerNode | undefined, dir: -1 | 1) => {
        const cfg = await loadConfig();
        const group = await pickGroupFromNodeOrQuickPick(cfg, node);
        if (!group) return;
        const idx = cfg.groups.findIndex(g => g.id === group.id);
        if (idx < 0) return;
        const swapWith = idx + dir;
        if (swapWith < 0 || swapWith >= cfg.groups.length) return;
        const tmp = cfg.groups[swapWith];
        cfg.groups[swapWith] = cfg.groups[idx];
        cfg.groups[idx] = tmp;
        await saveConfig(cfg);
        await provider.refresh();
    };
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.moveGroupUp', async (node?: SubExplorerNode) => moveGroup(node, -1)));
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.moveGroupDown', async (node?: SubExplorerNode) => moveGroup(node, 1)));

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.addItem', async (node?: SubExplorerNode) => {
        const cfg = await loadConfig();
        const group = await pickGroupFromNodeOrQuickPick(cfg, node);
        if (!group) return;
        const picks: vscode.OpenDialogOptions = {
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: true,
            openLabel: 'Add to Group'
        };
        const uris = await vscode.window.showOpenDialog(picks);
        if (!uris || uris.length === 0) return;
        for (const uri of uris) {
            const rel = toRelPath(uri);
            if (rel && !group.items.includes(rel)) group.items.push(rel);
        }
        await saveConfig(cfg);
        await provider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.removeItem', async (node?: SubExplorerNode) => {
        if (!node || !node.groupId || !node.resourceUri) return;
        const cfg = await loadConfig();
        const group = cfg.groups.find(g => g.id === node.groupId);
        if (!group) return;
        const rel = toRelPath(node.resourceUri);
        if (!rel) return;
        group.items = group.items.filter(i => i !== rel);
        await saveConfig(cfg);
        await provider.refresh();
    }));

    // openItem removed per UX request

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.revealInExplorer', async (node: SubExplorerNode) => {
        if (!node?.resourceUri) return;
        await vscode.commands.executeCommand('revealInExplorer', node.resourceUri);
    }));

    // Explorer-like commands for file/dir nodes
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.openItem', async (arg1?: any, arg2?: any) => {
        // Supports invocation from tree nodes or direct command with (uri, groupId)
        let uri: vscode.Uri | undefined;
        let gidFromArg: string | undefined;
        if (arg1 && typeof arg1 === 'object' && 'type' in arg1) {
            const node = arg1 as SubExplorerNode;
            uri = node.resourceUri;
            gidFromArg = node.groupId;
        } else {
            uri = arg1 as vscode.Uri | undefined;
            gidFromArg = typeof arg2 === 'string' ? arg2 : undefined;
        }
        if (!uri) return;
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
            await vscode.commands.executeCommand('revealInExplorer', uri);
            return;
        }
    }));

    // Checkout group ref: switch current repository to the group's bound ref
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.checkoutGroupRef', async (arg1?: any, arg2?: any) => {
        // VS Code passes the tree node as the first arg from menus; support optional second arg as ref
        const node: SubExplorerNode | undefined = (arg1 && typeof arg1 === 'object' && 'type' in arg1) ? arg1 as SubExplorerNode : undefined;
        const ref: string | undefined = typeof arg1 === 'string' ? arg1 : (typeof arg2 === 'string' ? arg2 : undefined);
        const getTargetFromNode = async (): Promise<string | undefined> => {
            if (!node?.groupId) return undefined;
            const cfg = await loadConfig();
            const g = cfg.groups.find(x => x.id === node.groupId);
            return g?.gitRef;
        };
        const combined = ref ?? await getTargetFromNode();
        const target = typeof combined === 'string' ? combined.trim() : undefined;
        if (!target) {
            vscode.window.showWarningMessage(vscode.l10n.t('No git ref set for this group.'));
            return;
        }
        try {
            const ws = vscode.workspace.workspaceFolders?.[0];
            // Activate Git extension
            const gitExt = vscode.extensions.getExtension('vscode.git');
            await gitExt?.activate?.();
            const api = gitExt?.exports?.getAPI?.(1);
            const repo = (() => {
                if (!api?.repositories?.length) return undefined;
                if (!ws) return api.repositories[0];
                // Choose repo matching workspace root if possible
                const found = api.repositories.find((r: any) => r.rootUri?.fsPath === ws.uri.fsPath);
                return found || api.repositories[0];
            })();

            const headName = repo?.state?.HEAD?.name;
            const headCommit = repo?.state?.HEAD?.commit;
            if (headName === target || headCommit === target) {
                vscode.window.showInformationMessage(vscode.l10n.t('Already on {0}.', target));
                return;
            }

            // Try Git API
            if (repo?.checkout) {
                try {
                    await repo.checkout(target);
                    return;
                } catch (e) {
                    // Fallback to built-in command
                    await vscode.commands.executeCommand('git.checkout', target);
                    return;
                }
            }

            // Final fallback: run in integrated terminal
            if (!ws) throw new Error('No workspace folder');
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `git checkout ${target}` }, async () => {
                const term = vscode.window.createTerminal({ name: 'Sub Explorer Git', cwd: ws.uri.fsPath });
                term.show(true);
                term.sendText(`git checkout ${target}`);
            });
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            vscode.window.showErrorMessage(vscode.l10n.t('Checkout failed: {0}', msg));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.openItemToSide', async (node: SubExplorerNode) => {
        if (!node?.resourceUri) return;
        const stat = await vscode.workspace.fs.stat(node.resourceUri);
        if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
            await vscode.commands.executeCommand('revealInExplorer', node.resourceUri);
            return;
        }
        // Mark as user-initiated open from Sub Explorer to avoid immediate auto-reveal
        lastUserOpen = { uri: node.resourceUri, ts: Date.now() };
        const doc = await vscode.workspace.openTextDocument(node.resourceUri);
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        const recentSelection = lastSelection && (Date.now() - lastSelection.ts) < 400 && lastSelection.uri?.toString() === node.resourceUri.toString();
        if (!recentSelection && node.groupId && isActiveBehaviorEnabled()) {
            if (node.groupId !== provider.getActiveGroupId()) {
                await provider.setActiveGroup(node.groupId);
            }
            setTimeout(() => { provider.revealInActiveGroup(node.resourceUri!, treeView, { focus: false, selectFinal: false }).catch(() => { }); }, 30);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.revealInOS', async (node: SubExplorerNode) => {
        if (!node?.resourceUri) return;
        await vscode.commands.executeCommand('revealFileInOS', node.resourceUri);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.copyPath', async (node: SubExplorerNode) => {
        if (!node?.resourceUri) return;
        await vscode.env.clipboard.writeText(node.resourceUri.fsPath);
        vscode.window.showInformationMessage('Path copied to clipboard');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.copyRelativePath', async (node: SubExplorerNode) => {
        if (!node?.resourceUri) return;
        const rel = toRelPath(node.resourceUri);
        if (!rel) return;
        await vscode.env.clipboard.writeText(rel);
        vscode.window.showInformationMessage('Relative path copied to clipboard');
    }));

    // Group settings Webview
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.groupSettings', async (node?: SubExplorerNode) => {
        const cfg = await loadConfig();
        const group = await pickGroupFromNodeOrQuickPick(cfg, node);
        if (!group) {
            vscode.window.showInformationMessage('No group selected.');
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'subExplorerGroupSettings',
            `Group Settings: ${group.name}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: false }
        );

        const updateHtml = (g: GroupConfig) => {
            panel.webview.html = getGroupSettingsHtml(panel.webview, context, g);
        };
        updateHtml(group);

        panel.webview.onDidReceiveMessage(async (message) => {
            const cfgNow = await loadConfig();
            const current = cfgNow.groups.find(x => x.id === group.id);
            if (!current) return;
            switch (message?.type) {
                case 'rename': {
                    const newName = String(message.name || '').trim();
                    if (!newName) return;
                    current.name = newName;
                    await saveConfig(cfgNow);
                    await provider.refresh();
                    panel.title = vscode.l10n.t('Group Settings: {0}', newName);
                    updateHtml(current);
                    vscode.window.showInformationMessage(vscode.l10n.t('Group name saved.'));
                    break;
                }
                case 'setGitRef': {
                    const ref = String(message.ref || '').trim() || undefined;
                    current.gitRef = ref;
                    await saveConfig(cfgNow);
                    await provider.refresh();
                    updateHtml(current);
                    vscode.window.showInformationMessage(ref ? vscode.l10n.t('Git ref set to "{0}".', ref) : vscode.l10n.t('Git ref cleared.'));
                    break;
                }
                case 'clearGitRef': {
                    delete current.gitRef;
                    await saveConfig(cfgNow);
                    await provider.refresh();
                    updateHtml(current);
                    vscode.window.showInformationMessage(vscode.l10n.t('Git ref cleared.'));
                    break;
                }
                case 'removeItem': {
                    const rel: string = message.rel;
                    current.items = current.items.filter(i => i !== rel);
                    await saveConfig(cfgNow);
                    await provider.refresh();
                    updateHtml(current);
                    vscode.window.showInformationMessage(vscode.l10n.t('Removed: {0}', rel));
                    break;
                }
                case 'addItems': {
                    const picks: vscode.OpenDialogOptions = {
                        canSelectFiles: true,
                        canSelectFolders: true,
                        canSelectMany: true,
                        openLabel: 'Add to Group'
                    };
                    const uris = await vscode.window.showOpenDialog(picks);
                    if (uris && uris.length) {
                        for (const u of uris) {
                            const rel = toRelPath(u);
                            if (rel && !current.items.includes(rel)) current.items.push(rel);
                        }
                        await saveConfig(cfgNow);
                        await provider.refresh();
                        updateHtml(current);
                        vscode.window.showInformationMessage(vscode.l10n.t('Added {0} item(s).', uris.length));
                    }
                    break;
                }
            }
        }, undefined, context.subscriptions);

        panel.onDidDispose(() => { /* no-op */ }, null, context.subscriptions);
    }));

    // Add selected items in Explorer to a group (supports multi-select)
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.addSelectedToGroup', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        // VS Code passes the first clicked resource as `uri` and the full selection as `uris`
        // Try to read multi-selection from the explorer if not provided
        const selected = (uris && uris.length ? uris : (uri ? [uri] : [])) as vscode.Uri[];
        let items: vscode.Uri[] = selected;
        if (!items.length) {
            // As a fallback, try Editor or show picker
            const active = vscode.window.activeTextEditor?.document.uri;
            if (active) items = [active];
            if (!items.length) {
                const picks = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, openLabel: 'Add to Group' });
                if (!picks || !picks.length) return;
                items = picks;
            }
        }

        const cfg = await loadConfig();
        const group = await pickGroupFromNodeOrQuickPick(cfg);
        if (!group) {
            vscode.window.showInformationMessage('Create a group first via Sub Explorer: Add Group');
            return;
        }
        let added = 0;
        for (const u of items) {
            const rel = toRelPath(u);
            if (rel && !group.items.includes(rel)) {
                group.items.push(rel);
                added++;
            }
        }
        if (added > 0) {
            await saveConfig(cfg);
            await vscode.commands.executeCommand('subExplorer.refresh');
            vscode.window.showInformationMessage(`Added ${added} item(s) to group ${group.name}.`);
        }
    }));

    // Search within a group's items: prefill Find in Files includes (top-level only, using **)
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.searchInGroup', async (node?: SubExplorerNode) => {
        const cfg = await loadConfig();
        const group = await pickGroupFromNodeOrQuickPick(cfg, node);
        if (!group) {
            vscode.window.showInformationMessage(vscode.l10n.t('No group selected.'));
            return;
        }
        if (!group.items || group.items.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('This group has no items.'));
            return;
        }

        // Build filesToInclude (non-recursive) and filesToExclude (block deeper levels)
        // - file: include its exact path
        // - directory: include immediate children only via path/* and exclude path/*/**
        const parts: string[] = [];
        const excludeParts: string[] = [];
        for (const rel of group.items) {
            const p = rel?.trim();
            if (!p) continue;
            try {
                const uri = toFsUri(p);
                if (!uri) { continue; }
                const stat = await vscode.workspace.fs.stat(uri);
                if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
                    parts.push(`${p}/*`);
                    excludeParts.push(`${p}/*/**`);
                } else {
                    parts.push(p);
                }
            } catch {
                // If stat fails, default to non-recursive immediate children
                parts.push(`${p}/*`);
                excludeParts.push(`${p}/*/**`);
            }
        }
        const uniq = Array.from(new Set(parts));
        const uniqEx = Array.from(new Set(excludeParts));
        if (uniq.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('No valid paths found for this group.'));
            return;
        }
        const includes = uniq.length === 1 ? uniq[0] : `{${uniq.join(',')}}`;
        const excludes = uniqEx.length === 0 ? undefined : (uniqEx.length === 1 ? uniqEx[0] : `{${uniqEx.join(',')}}`);

        // Open the search view with includes prefilled; user can type the query
        await vscode.commands.executeCommand('workbench.action.findInFiles', {
            query: '',
            replace: undefined,
            triggerSearch: false,
            filesToInclude: includes,
            filesToExclude: excludes,
            isRegex: false,
            isCaseSensitive: false,
            matchWholeWord: false,
            useExcludeSettingsAndIgnoreFiles: true
        });
        await vscode.commands.executeCommand('workbench.view.search');
    }));
}

async function pickGroupFromNodeOrQuickPick(cfg: SubExplorerConfig, node?: SubExplorerNode): Promise<GroupConfig | undefined> {
    if (node?.type === 'group' && node.groupId) {
        return cfg.groups.find(g => g.id === node.groupId);
    }
    if (cfg.groups.length === 0) return undefined;
    if (cfg.groups.length === 1) return cfg.groups[0];
    const picked = await vscode.window.showQuickPick(
        cfg.groups.map(g => ({ label: g.name, description: g.id, g })),
        { placeHolder: 'Select a group' }
    );
    return picked?.g;
}

export function deactivate() { }

function getGroupSettingsHtml(webview: vscode.Webview, context: vscode.ExtensionContext, group: GroupConfig): string {
    const nonce = getNonce();
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const itemsHtml = group.items.map(rel => `
                <li class="item">
                        <code>${escape(rel)}</code>
                        <button class="btn btn-danger" data-rel="${escape(rel)}">Remove</button>
                </li>`).join('');
    const ref = group.gitRef ? escape(group.gitRef) : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Group Settings</title>
    <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
        h2 { margin-top: 0; }
        .row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
        input[type=text] { flex: 1; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
        button { padding: 4px 10px; }
        ul { list-style: none; padding-left: 0; }
        li.item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--vscode-editorGroup-border); }
        code { font-family: var(--vscode-editor-font-family); }
        .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
        .btn-danger { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; }
    </style>
    </head>
    <body>
        <h2>Group Settings</h2>
            <div class="row">
            <label for="gname">Name:</label>
            <input id="gname" type="text" value="${escape(group.name)}" />
            <button id="rename" class="btn-primary">Save Name</button>
        </div>
            <div class="row">
                <label for="gref">Git Ref:</label>
                <input id="gref" type="text" placeholder="branch or commit hash" value="${ref}" />
                <button id="saveRef" class="btn-primary">Save Ref</button>
                <button id="clearRef" class="btn-danger">Clear</button>
            </div>
        <div class="row">
            <button id="add" class="btn-primary">Add Items…</button>
        </div>
        <h3>Items</h3>
        <ul id="items">${itemsHtml || '<li><em>No items yet</em></li>'}</ul>
        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
                    const renameBtn = document.getElementById('rename');
                    const addBtn = document.getElementById('add');
                    const saveRefBtn = document.getElementById('saveRef');
                    const clearRefBtn = document.getElementById('clearRef');

                    renameBtn.addEventListener('click', () => {
                        const nameEl = document.getElementById('gname');
                        const name = (nameEl?.value || '').trim();
                        renameBtn.setAttribute('disabled', 'true');
                        const old = renameBtn.textContent; renameBtn.textContent = 'Saving…';
                        vscode.postMessage({ type: 'rename', name });
                        // Page will refresh on success; fallback restore after 1.5s if not
                        setTimeout(() => { renameBtn.removeAttribute('disabled'); renameBtn.textContent = old; }, 1500);
                    });
                    addBtn.addEventListener('click', () => {
                        addBtn.setAttribute('disabled', 'true');
                        const old = addBtn.textContent; addBtn.textContent = 'Opening…';
                        vscode.postMessage({ type: 'addItems' });
                        setTimeout(() => { addBtn.removeAttribute('disabled'); addBtn.textContent = old; }, 2000);
                    });
                    saveRefBtn.addEventListener('click', () => {
                        const refEl = document.getElementById('gref');
                        const ref = (refEl?.value || '').trim();
                        saveRefBtn.setAttribute('disabled', 'true');
                        const old = saveRefBtn.textContent; saveRefBtn.textContent = 'Saving…';
                        vscode.postMessage({ type: 'setGitRef', ref });
                        setTimeout(() => { saveRefBtn.removeAttribute('disabled'); saveRefBtn.textContent = old; }, 1500);
                    });
                    clearRefBtn.addEventListener('click', () => {
                        clearRefBtn.setAttribute('disabled', 'true');
                        const old = clearRefBtn.textContent; clearRefBtn.textContent = 'Clearing…';
                        vscode.postMessage({ type: 'clearGitRef' });
                        setTimeout(() => { clearRefBtn.removeAttribute('disabled'); clearRefBtn.textContent = old; }, 1500);
                    });
                    document.getElementById('items').addEventListener('click', (e) => {
                const t = e.target;
                if (t && t.matches('button[data-rel]')) {
                            const btn = t;
                            const rel = t.getAttribute('data-rel');
                            btn.setAttribute('disabled', 'true');
                            const old = btn.textContent; btn.textContent = 'Removing…';
                            vscode.postMessage({ type: 'removeItem', rel });
                            setTimeout(() => { btn.removeAttribute('disabled'); btn.textContent = old; }, 1500);
                }
            });
        </script>
    </body>
</html>`;
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
