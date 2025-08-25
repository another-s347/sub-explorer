import * as vscode from 'vscode';
import * as path from 'path';
import { GroupConfig, loadConfig, toFsUri } from './config';

export type NodeType = 'group' | 'item' | 'fs' | 'path';

export class SubExplorerNode extends vscode.TreeItem {
    constructor(
        public readonly type: NodeType,
        public readonly labelText: string,
        public readonly resourceUri?: vscode.Uri,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
        public readonly contextValue?: string,
        public readonly groupId?: string,
        public readonly rootRel?: string,
    public readonly isTerminal?: boolean,
    ) {
        super(labelText, collapsibleState);
        if (resourceUri) {
            this.resourceUri = resourceUri;
        }
        if (contextValue) this.contextValue = contextValue;
    }
}

export class SubExplorerProvider implements vscode.TreeDataProvider<SubExplorerNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SubExplorerNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private groups: GroupConfig[] = [];
    private fsWatcher?: vscode.FileSystemWatcher;
    private cfgWatcher?: vscode.FileSystemWatcher;
    private displayMode: 'name' | 'fullPath' = 'name';

    constructor(private readonly context: vscode.ExtensionContext) {
        this.refresh();
        // Watch config file changes and workspace file changes for refresh
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws) {
            // Light FS watcher to refresh when files change under included folders (best-effort)
            this.fsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ws, '**'));
            this.fsWatcher.onDidChange(() => this._onDidChangeTreeData.fire());
            this.fsWatcher.onDidCreate(() => this._onDidChangeTreeData.fire());
            this.fsWatcher.onDidDelete(() => this._onDidChangeTreeData.fire());

            // Config watcher
            this.cfgWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ws, '.vscode/sub-explorer.json'));
            this.cfgWatcher.onDidChange(() => this.refresh());
            this.cfgWatcher.onDidCreate(() => this.refresh());
            this.cfgWatcher.onDidDelete(() => this.refresh());
        }
        // React to display mode setting changes
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('subExplorer.displayMode')) {
                    const mode = vscode.workspace.getConfiguration('subExplorer').get<'name' | 'fullPath'>('displayMode', 'name');
                    this.displayMode = mode;
                    this._onDidChangeTreeData.fire();
                }
            })
        );
    }

    dispose() {
        this.fsWatcher?.dispose();
        this.cfgWatcher?.dispose();
    }

    async refresh(): Promise<void> {
        this.groups = (await loadConfig()).groups;
        const mode = vscode.workspace.getConfiguration('subExplorer').get<'name' | 'fullPath'>('displayMode', 'name');
        this.displayMode = mode;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SubExplorerNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SubExplorerNode): Promise<SubExplorerNode[]> {
        if (!element) {
            // root: groups
            return this.groups.map(g => new SubExplorerNode(
                'group',
                g.name,
                undefined,
                vscode.TreeItemCollapsibleState.Expanded,
                'group',
                g.id,
            ));
        }

        if (element.type === 'group') {
            const group = this.groups.find(g => g.id === element.groupId);
            if (!group) return [];
                if (this.displayMode === 'fullPath') {
                    return await this.buildPathChildren(group, undefined);
                } else {
                    const nodes: SubExplorerNode[] = [];
                    for (const rel of group.items) {
                        const uri = toFsUri(rel);
                        if (!uri) continue;
                        try {
                            const stat = await vscode.workspace.fs.stat(uri);
                            const isDir = (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
                            const label = path.basename(uri.fsPath);
                            const node = new SubExplorerNode(
                                'item',
                                label,
                                uri,
                                isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                                'item',
                                group.id,
                                rel,
                                true,
                            );
                            node.tooltip = rel;
                            nodes.push(node);
                        } catch { }
                    }
                    return nodes;
                }
        }

            if (element.type === 'path') {
                const group = this.groups.find(g => g.id === element.groupId);
                if (!group) return [];
                if (element.isTerminal) {
                    // Terminal path: if directory -> list real FS children, else leaf
                    if (!element.resourceUri) return [];
                    try {
                        const stat = await vscode.workspace.fs.stat(element.resourceUri);
                        const isDir = (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
                        if (!isDir) return [];
                        return await this.listFsChildren(element);
                    } catch {
                        return [];
                    }
                }
                // Non-terminal path: build next path level
                const prefixRel = this.makeRelFromUri(element.resourceUri!);
                return await this.buildPathChildren(group, prefixRel);
            }

        if (element.type === 'item' || element.type === 'fs') {
            // list children of a folder
            if (!element.resourceUri) return [];
            try {
                    return await this.listFsChildren(element);
            } catch {
                return [];
            }
        }

        return [];
    }

        private async buildPathChildren(group: GroupConfig, prefixRel: string | undefined): Promise<SubExplorerNode[]> {
            // Build unique next segments under prefixRel (undefined means top-level under group)
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) return [];
            const prefix = prefixRel ? prefixRel.replace(/\\/g, '/') : '';
            const seen = new Map<string, { fullRel: string; isTerminal: boolean }>();
            for (const rel of group.items) {
                if (prefix && !(rel === prefix || rel.startsWith(prefix + '/'))) continue;
                const rest = prefix ? rel.slice(prefix.length).replace(/^\//, '') : rel;
                const firstSeg = rest.split('/')[0];
                if (!firstSeg) continue;
                const segRel = prefix ? `${prefix}/${firstSeg}` : firstSeg;
                const isTerminal = rel === segRel;
                const prev = seen.get(firstSeg);
                if (!prev) {
                    seen.set(firstSeg, { fullRel: segRel, isTerminal });
                } else {
                    // if any is terminal, keep terminal true
                    prev.isTerminal = prev.isTerminal || isTerminal;
                }
            }
            const nodes: SubExplorerNode[] = [];
            for (const [name, { fullRel, isTerminal }] of seen) {
                const uri = toFsUri(fullRel);
                if (!uri) continue;
                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    const isDir = (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
                    const collapsible = isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
                    const context = isTerminal ? 'item' : 'fs';
                    const node = new SubExplorerNode(
                        'path',
                        name,
                        uri,
                        collapsible,
                        context,
                        group.id,
                        fullRel,
                        isTerminal,
                    );
                    node.tooltip = fullRel;
                    nodes.push(node);
                } catch { }
            }
            // sort alpha by label
            nodes.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));
            return nodes;
        }

        private async listFsChildren(element: SubExplorerNode): Promise<SubExplorerNode[]> {
            const entries: [string, vscode.FileType][] = await vscode.workspace.fs.readDirectory(element.resourceUri!);
            const rootRel = element.rootRel ?? this.findRootRel(element.groupId, element.resourceUri!);
                const children = await Promise.all(entries.map(async ([name, ftype]: [string, vscode.FileType]) => {
                const childUri = vscode.Uri.joinPath(element.resourceUri!, name);
                const isDir = (ftype & vscode.FileType.Directory) === vscode.FileType.Directory;
                    const label = name; // keep tree hierarchical; show only current node name
                const child = new SubExplorerNode(
                    'fs',
                    label,
                    childUri,
                    isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                    'fs',
                    element.groupId,
                    rootRel,
                );
                    child.tooltip = this.makeFullPathFromRoot(rootRel, childUri);
                return child;
            }));
            return children;
        }
    private makeFullPathFromRoot(rootRel: string | undefined, uri: vscode.Uri): string {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) return uri.fsPath;
        const wsRel = path.relative(ws.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
        if (!rootRel) return wsRel;
        const rootFs = path.join(ws.uri.fsPath, rootRel);
        const relUnderRoot = path.relative(rootFs, uri.fsPath).replace(/\\/g, '/');
        return relUnderRoot ? `${rootRel}/${relUnderRoot}` : rootRel;
    }

    private findRootRel(groupId: string | undefined, uri: vscode.Uri): string | undefined {
        if (!groupId) return undefined;
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) return undefined;
        const group = this.groups.find(g => g.id === groupId);
        if (!group) return undefined;
        const uriFs = uri.fsPath;
        // Pick the longest matching root (in case of nested roots)
        let best: string | undefined;
        for (const rel of group.items) {
            const rootFs = path.join(ws.uri.fsPath, rel);
            if (uriFs.startsWith(rootFs)) {
                if (!best || rel.length > best.length) best = rel;
            }
        }
        return best;
    }

    private makeRelFromUri(uri: vscode.Uri): string {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) return uri.fsPath.replace(/\\/g, '/');
        return path.relative(ws.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
    }
}
