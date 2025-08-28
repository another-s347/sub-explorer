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
    private fsWatchers: vscode.FileSystemWatcher[] = [];
    private cfgWatcher?: vscode.FileSystemWatcher;
    private displayMode: 'name' | 'fullPath' = 'name';
    private collapseOthersOnActivate = false;
    private activeBehaviorEnabled = true;
    private dirCache: Map<string, { entries: [string, vscode.FileType][], ts: number }> = new Map();
    private branchCache?: { value?: string; ts: number };
    private refreshTimer?: NodeJS.Timeout;
    private activeGroupId?: string;
    private output: vscode.OutputChannel;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.output = vscode.window.createOutputChannel('Sub Explorer');
        this.activeGroupId = context.workspaceState.get<string>('subExplorer.activeGroupId');
        this.refresh();
        // Watch config file changes and workspace file changes for refresh
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws) {
            // Config watcher
            this.cfgWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ws, '.vscode/sub-explorer.json'));
            this.cfgWatcher.onDidChange(() => this.refresh());
            this.cfgWatcher.onDidCreate(() => this.refresh());
            this.cfgWatcher.onDidDelete(() => this.refresh());
        }
        // React to display mode setting changes
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (
                    e.affectsConfiguration('subExplorer.displayMode') ||
                    e.affectsConfiguration('subExplorer.collapseOthersOnActivate') ||
                    e.affectsConfiguration('subExplorer.activeBehaviorEnabled')
                ) {
                    const mode = vscode.workspace.getConfiguration('subExplorer').get<'name' | 'fullPath'>('displayMode', 'name');
                    this.displayMode = mode;
                    this.collapseOthersOnActivate = vscode.workspace.getConfiguration('subExplorer').get<boolean>('collapseOthersOnActivate', false);
                    this.activeBehaviorEnabled = vscode.workspace.getConfiguration('subExplorer').get<boolean>('activeBehaviorEnabled', true);
                    this.fireRefreshDebounced();
                }
            })
        );
    }

    dispose() {
        this.disposeFsWatchers();
        this.cfgWatcher?.dispose();
    }

    async refresh(): Promise<void> {
        this.groups = (await loadConfig()).groups;
        const mode = vscode.workspace.getConfiguration('subExplorer').get<'name' | 'fullPath'>('displayMode', 'name');
        this.displayMode = mode;
        this.collapseOthersOnActivate = vscode.workspace.getConfiguration('subExplorer').get<boolean>('collapseOthersOnActivate', false);
        this.activeBehaviorEnabled = vscode.workspace.getConfiguration('subExplorer').get<boolean>('activeBehaviorEnabled', true);
        this.branchCache = undefined;
        this.dirCache.clear();
        this.resetFsWatchers();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SubExplorerNode): vscode.TreeItem {
        return element;
    }

    async getParent(element: SubExplorerNode): Promise<SubExplorerNode | undefined> {
        // Group is root
        if (element.type === 'group') return undefined;
        const group = this.groups.find(g => g.id === element.groupId);
        if (!group) return undefined;

        // Parent of top-level item (name mode) is the group
        if (element.type === 'item') {
            const node = new SubExplorerNode('group', group.name, undefined, vscode.TreeItemCollapsibleState.Expanded, this.activeGroupId === group.id ? 'groupActive' : 'group', group.id);
            node.id = `group:${group.id}`;
            return node;
        }

        // Parent of path node: either another path segment or the group
        if (element.type === 'path') {
            const fullRel = element.rootRel ?? '';
            const idx = fullRel.lastIndexOf('/');
            if (idx <= 0) {
                const node = new SubExplorerNode('group', group.name, undefined, vscode.TreeItemCollapsibleState.Expanded, this.activeGroupId === group.id ? 'groupActive' : 'group', group.id);
                node.id = `group:${group.id}`;
                return node;
            }
            const parentRel = fullRel.slice(0, idx);
            const parentUri = toFsUri(parentRel);
            const pn = new SubExplorerNode('path', parentRel.split('/').pop() || parentRel, parentUri, vscode.TreeItemCollapsibleState.Collapsed, 'fs', group.id, parentRel, fullRel === parentRel);
            pn.id = `path:${group.id}:${parentRel}`;
            return pn;
        }

        // FS node: parent is previous directory; if equals rootRel, parent is item (name mode) or path (fullPath)
        if (element.type === 'fs') {
            if (!element.resourceUri) return undefined;
            const wsRel = this.makeRelFromUri(element.resourceUri);
            const parentWsRel = wsRel.includes('/') ? wsRel.slice(0, wsRel.lastIndexOf('/')) : '';
            if (parentWsRel === (element.rootRel ?? '')) {
                if (this.displayMode === 'name') {
                    const uri = toFsUri(parentWsRel);
                    const it = new SubExplorerNode('item', parentWsRel.split('/').pop() || parentWsRel, uri, vscode.TreeItemCollapsibleState.Collapsed, 'item', group.id, parentWsRel, true);
                    it.id = `item:${group.id}:${parentWsRel}`;
                    return it;
                } else {
                    const uri = toFsUri(parentWsRel);
                    const pn = new SubExplorerNode('path', parentWsRel.split('/').pop() || parentWsRel, uri, vscode.TreeItemCollapsibleState.Collapsed, 'item', group.id, parentWsRel, true);
                    pn.id = `path:${group.id}:${parentWsRel}`;
                    return pn;
                }
            }
            // Otherwise parent is another fs node
            const parentUri = vscode.Uri.joinPath(element.resourceUri, '..');
            const label = parentWsRel.split('/').pop() || parentWsRel;
            const fsn = new SubExplorerNode('fs', label, parentUri, vscode.TreeItemCollapsibleState.Collapsed, 'fs', group.id, element.rootRel);
            const relParent = this.makeRelFromUri(parentUri);
            fsn.id = `fs:${group.id}:${relParent}`;
            return fsn;
        }
        return undefined;
    }

    async getChildren(element?: SubExplorerNode): Promise<SubExplorerNode[]> {
        if (!element) {
            // root: groups
            // Root: groups; show gitRef if set
            const gitBranch = await this.getCurrentBranch();
            return this.groups.map(g => {
                const mismatch = !!(g.gitRef && gitBranch && g.gitRef !== gitBranch);
                const isActive = this.activeBehaviorEnabled && this.activeGroupId === g.id;
                const contextVal = mismatch
                    ? (isActive ? 'groupMismatchActive' : 'groupMismatch')
                    : (isActive ? 'groupActive' : 'group');
                const collapsible = (this.activeBehaviorEnabled && this.collapseOthersOnActivate && this.activeGroupId)
                    ? (isActive ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
                    : vscode.TreeItemCollapsibleState.Expanded;
                const node = new SubExplorerNode(
                    'group',
                    g.name,
                    undefined,
                    collapsible,
                    contextVal,
                    g.id,
                );
                node.id = `group:${g.id}`;
                // Secondary text (description): show gitRef and/or active marker
                const descParts: string[] = [];
                if (g.gitRef) descParts.push(g.gitRef);
                if (isActive) descParts.push('active');
                node.description = descParts.length ? descParts.join(' • ') : undefined;
                if (g.gitRef) {
                    node.tooltip = `${g.name} — ${g.gitRef}${mismatch ? ` (current: ${gitBranch ?? 'unknown'})` : ''}`;
                }
                return node;
            });
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
                        node.id = `item:${group.id}:${rel}`;
                        node.tooltip = rel;
                        if (!isDir) {
                            node.command = {
                                command: 'subExplorer.openItem',
                                title: 'Open',
                                arguments: [uri, group.id]
                            };
                        }
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

    async setActiveGroup(id: string | undefined): Promise<void> {
        // When disabled, ignore attempts to set a non-undefined active group.
        if (!this.activeBehaviorEnabled && id) return;
        if (this.activeGroupId === id) return;
        this.activeGroupId = id;
        this.context.workspaceState.update('subExplorer.activeGroupId', id);
        if (this.collapseOthersOnActivate) {
            this._onDidChangeTreeData.fire();
        } else {
            // Defer refresh a bit to avoid clearing selection immediately (reduces flicker)
            setTimeout(() => this._onDidChangeTreeData.fire(), 250);
        }
        // Yield microtask
        await new Promise(res => setTimeout(res, 0));
    }

    getActiveGroupId(): string | undefined {
        return this.activeGroupId;
    }

    // Determine which group a URI belongs to (longest matching root across all groups)
    public findGroupIdForUri(uri: vscode.Uri, preferGroupId?: string): string | undefined {
        const dbg = vscode.workspace.getConfiguration('subExplorer').get<boolean>('debug', false);
        const log = (m: string) => { if (dbg) this.output.appendLine(`[auto] ${m}`); };
        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        const ws = wsFolder ?? vscode.workspace.workspaceFolders?.[0];
        if (!ws) { log('no workspace for uri'); return undefined; }
        const target = uri.fsPath;
        const candidates: { gid: string; len: number; rel: string }[] = [];
        for (const g of this.groups) {
            for (const rel of g.items) {
                const rootFs = path.join(ws.uri.fsPath, rel);
                if (target === rootFs || target.startsWith(rootFs + path.sep)) {
                    candidates.push({ gid: g.id, len: rootFs.length, rel });
                }
            }
        }
        if (candidates.length === 0) { log(`no matching group for ${target}`); return undefined; }
        // Prefer current active group if it's a candidate
        if (preferGroupId && candidates.some(c => c.gid === preferGroupId)) {
            log(`keeping active group ${preferGroupId} for ${target}`);
            return preferGroupId;
        }
        // Otherwise pick the most specific (longest root)
        candidates.sort((a, b) => b.len - a.len);
        const chosen = candidates[0];
        log(`candidates: ${candidates.map(c => `${c.gid}:${c.rel}:${c.len}`).join(', ')}`);
        log(`chosen group for ${target}: ${chosen.gid}`);
        return chosen.gid;
    }

    // Try to reveal a URI under the active group if it matches any group root
    async revealInActiveGroup(uri: vscode.Uri, treeView: vscode.TreeView<SubExplorerNode>, options?: { focus?: boolean; selectFinal?: boolean; groupId?: string }): Promise<SubExplorerNode | undefined> {
        const dbg = vscode.workspace.getConfiguration('subExplorer').get<boolean>('debug', false);
        const log = (m: string) => { if (dbg) this.output.appendLine(`[reveal] ${m}`); };
        // If disabled and no explicit groupId provided, do nothing
        if (!this.activeBehaviorEnabled && !options?.groupId) { log('active behavior disabled'); return undefined; }
        const gid = options?.groupId ?? this.activeGroupId;
        if (!gid) { log('no active group'); return undefined; }
        const group = this.groups.find(g => g.id === gid);
        if (!group) { log('active group not found'); return undefined; }
        // Support multi-root: pick the workspace folder that contains the target file
        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        const ws = wsFolder ?? vscode.workspace.workspaceFolders?.[0];
        if (!ws) { log('no workspace'); return undefined; }
        // Check if the file sits under any of the group's roots
        const fsPath = uri.fsPath;
        let rootRel: string | undefined;
        let bestLen = -1;
        for (const rel of group.items) {
            const rootFs = path.join(ws.uri.fsPath, rel);
            if (fsPath === rootFs || fsPath.startsWith(rootFs + path.sep)) {
                if (rootFs.length > bestLen) {
                    rootRel = rel;
                    bestLen = rootFs.length;
                }
            }
        }
        log(`match rootRel=${rootRel ?? 'none'} for ${fsPath}`);
        if (!rootRel) return undefined;
        const absRoot = path.join(ws.uri.fsPath, rootRel!);
        const rootSegs = rootRel.split('/');
        const relUnderRoot = path.relative(absRoot, fsPath).replace(/\\/g, '/');
        const fileSegs = relUnderRoot ? relUnderRoot.split('/') : [];
        // Reveal the group node first
        const groups = await this.getChildren();
        const groupNode = groups.find(n => n.type === 'group' && n.groupId === gid);
        if (!groupNode) { log('group node not found'); return undefined; }

        // Walk depending on display mode
        let parent: SubExplorerNode = groupNode;
        if (this.displayMode === 'name') {
            // Top are items; find the root item then walk file segments
            const topChildren = await this.getChildren(groupNode);
            const rootItem = topChildren.find(n => n.rootRel === rootRel)
                ?? topChildren.find(n => n.label?.toString() === path.basename(rootRel!));
            if (!rootItem) { log('root item node not found'); return undefined; }

            parent = rootItem;
            for (const seg of fileSegs) {
                const kids = await this.getChildren(parent);
                const next = kids.find(k => k.label?.toString() === seg)
                    ?? kids.find(k => k.resourceUri && path.basename(k.resourceUri.fsPath) === seg);
                if (!next) { log(`segment not found (name): ${seg}`); break; }
                parent = next;
            }
        } else {
            // fullPath mode: walk root segments first (top-level path nodes), then file segments
            const allSegs = [...rootSegs, ...fileSegs];
            for (const seg of allSegs) {
                const kids = await this.getChildren(parent);
                const next = kids.find(k => k.label?.toString() === seg)
                    ?? kids.find(k => k.resourceUri && k.resourceUri.fsPath.endsWith(path.sep + seg));
                if (!next) { log(`segment not found (fullPath): ${seg}`); break; }
                parent = next;
            }
        }
        if (parent?.resourceUri?.fsPath !== fsPath) {
            // Attempt a last-step match among current children by fsPath
            const kids = await this.getChildren(parent);
            const exact = kids.find(k => k.resourceUri?.fsPath === fsPath);
            if (exact) {
                try {
                    log(`reveal final exact: ${exact.label}`);
                    await treeView.reveal(exact, { expand: true, focus: !!options?.focus, select: !!options?.selectFinal });
                } catch (err: any) {
                    log(`final reveal(exact) failed: ${err?.message ?? String(err)}`);
                }
                return exact;
            } else {
                log('final node not matched');
            }
        } else {
            // Parent itself is the target file/folder
            try {
                log(`reveal final parent: ${parent.label}`);
                await treeView.reveal(parent, { expand: true, focus: !!options?.focus, select: !!options?.selectFinal });
            } catch (err: any) {
                log(`final reveal(parent) failed: ${err?.message ?? String(err)}`);
            }
            return parent;
        }
        return undefined;
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
                let collapsible: vscode.TreeItemCollapsibleState;
                let context: string;
                if (!isTerminal) {
                    // Non-terminal path segments are directories by construction; avoid stat for speed
                    collapsible = vscode.TreeItemCollapsibleState.Collapsed;
                    context = 'fs';
                } else {
                    const stat = await vscode.workspace.fs.stat(uri);
                    const isDir = (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
                    collapsible = isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
                    context = 'item';
                }
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
                node.id = `path:${group.id}:${fullRel}`;
                node.tooltip = fullRel;
                if (isTerminal) {
                    try {
                        const st = await vscode.workspace.fs.stat(uri);
                        const isDir = (st.type & vscode.FileType.Directory) === vscode.FileType.Directory;
                        if (!isDir) {
                            node.command = {
                                command: 'subExplorer.openItem',
                                title: 'Open',
                                arguments: [uri, group.id]
                            };
                        }
                    } catch { }
                }
                nodes.push(node);
            } catch { }
        }
        // sort alpha by label
        nodes.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));
        return nodes;
    }

    private async listFsChildren(element: SubExplorerNode): Promise<SubExplorerNode[]> {
        const entries: [string, vscode.FileType][] = await this.readDirCached(element.resourceUri!);
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
            // Stable id based on workspace-relative path
            const relWs = this.makeRelFromUri(childUri);
            child.id = `fs:${element.groupId}:${relWs}`;
            child.tooltip = this.makeFullPathFromRoot(rootRel, childUri);
            if (!isDir) {
                child.command = {
                    command: 'subExplorer.openItem',
                    title: 'Open',
                    arguments: [childUri, element.groupId]
                };
            }
            return child;
        }));
        // Keep dictionary order like filesystem
        children.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));
        return children;
    }

    private async readDirCached(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const key = uri.fsPath;
        const now = Date.now();
        const cached = this.dirCache.get(key);
        if (cached && (now - cached.ts) < 3000) {
            return cached.entries;
        }
        const entries = await vscode.workspace.fs.readDirectory(uri);
        this.dirCache.set(key, { entries, ts: now });
        return entries;
    }

    private fireRefreshDebounced() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this._onDidChangeTreeData.fire();
        }, 150);
    }

    private resetFsWatchers() {
        this.disposeFsWatchers();
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) return;
        // Create watchers only for configured roots to reduce churn
        for (const g of this.groups) {
            for (const rel of g.items) {
                const pattern = new vscode.RelativePattern(ws, `${rel}/**`);
                const w = vscode.workspace.createFileSystemWatcher(pattern);
                const onChange = () => { this.dirCache.clear(); this.fireRefreshDebounced(); };
                w.onDidChange(onChange);
                w.onDidCreate(onChange);
                w.onDidDelete(onChange);
                this.fsWatchers.push(w);
            }
        }
    }

    private disposeFsWatchers() {
        for (const w of this.fsWatchers) {
            try { w.dispose(); } catch { }
        }
        this.fsWatchers = [];
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

    private async getCurrentBranch(): Promise<string | undefined> {
        // Try the built-in Git extension API first; fallback to reading HEAD file.
        const now = Date.now();
        if (this.branchCache && (now - this.branchCache.ts) < 2000) {
            return this.branchCache.value;
        }
        let value: string | undefined = undefined;
        try {
            const gitExt = vscode.extensions.getExtension('vscode.git');
            const api = gitExt?.exports?.getAPI?.(1);
            const repo = api?.repositories?.[0];
            const branch = repo?.state?.HEAD?.name;
            if (branch) value = branch;
        } catch { }
        try {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) return undefined;
            const headUri = vscode.Uri.joinPath(ws.uri, '.git/HEAD');
            const data = await vscode.workspace.fs.readFile(headUri);
            const text = Buffer.from(data).toString('utf8').trim();
            const m = text.match(/^ref: refs\/heads\/(.+)$/);
            value = value ?? (m ? m[1] : undefined);
        } catch { /* ignore */ }
        this.branchCache = { value, ts: now };
        return value;
    }
}
