import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { SubExplorerProvider, SubExplorerNode } from './tree';
import { GroupConfig, SubExplorerConfig, loadConfig, saveConfig, toRelPath } from './config';

export async function activate(context: vscode.ExtensionContext) {
    const provider = new SubExplorerProvider(context);
    const treeView = vscode.window.createTreeView('subExplorerView', { treeDataProvider: provider, showCollapseAll: true });
    context.subscriptions.push(treeView);

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.refresh', () => provider.refresh()));

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
    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.openItem', async (node: SubExplorerNode) => {
        if (!node?.resourceUri) return;
        const stat = await vscode.workspace.fs.stat(node.resourceUri);
        if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
            await vscode.commands.executeCommand('revealInExplorer', node.resourceUri);
            return;
        }
        const doc = await vscode.workspace.openTextDocument(node.resourceUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('subExplorer.openItemToSide', async (node: SubExplorerNode) => {
        if (!node?.resourceUri) return;
        const stat = await vscode.workspace.fs.stat(node.resourceUri);
        if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
            await vscode.commands.executeCommand('revealInExplorer', node.resourceUri);
            return;
        }
        const doc = await vscode.workspace.openTextDocument(node.resourceUri);
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
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
