import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface GroupConfig {
    id: string;
    name: string;
    items: string[]; // workspace-relative paths
    gitRef?: string; // optional: bound branch name or commit hash
}

export interface SubExplorerConfig {
    groups: GroupConfig[];
}

const CONFIG_DIR = '.vscode';
const CONFIG_FILE = 'sub-explorer.json';

export function getConfigPath(): string | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { return undefined; }
    return path.join(ws.uri.fsPath, CONFIG_DIR, CONFIG_FILE);
}

export async function loadConfig(): Promise<SubExplorerConfig> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { return { groups: [] }; }
    const cfgPath = getConfigPath();
    if (!cfgPath) { return { groups: [] }; }
    try {
        const data = await fs.readFile(cfgPath, 'utf8');
        const parsed = JSON.parse(data) as SubExplorerConfig;
        if (!parsed.groups) parsed.groups = [];
        // Normalize items to posix-like workspace-relative paths
        parsed.groups.forEach(g => g.items = (g.items || []).map(p => normalizeRel(p)));
        return parsed;
    } catch (e: any) {
        return { groups: [] };
    }
}

export async function saveConfig(cfg: SubExplorerConfig): Promise<void> {
    const cfgPath = getConfigPath();
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!cfgPath || !ws) return;
    const dir = path.dirname(cfgPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

export function normalizeRel(p: string): string {
    return p.replace(/\\/g, '/');
}

export function toFsUri(rel: string): vscode.Uri | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return undefined;
    const fsPath = path.join(ws.uri.fsPath, rel);
    return vscode.Uri.file(fsPath);
}

export function toRelPath(uri: vscode.Uri): string | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return undefined;
    const rel = path.relative(ws.uri.fsPath, uri.fsPath);
    return normalizeRel(rel);
}
