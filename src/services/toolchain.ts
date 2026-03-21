import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface DarkBasicToolchain {
  readonly installRoot: string;
  readonly compilerRoot: string;
  readonly compilerExe: string;
  readonly toolsRoot: string;
  readonly dbnextExe?: string;
  readonly helpRoot: string;
  readonly tempRoot: string;
}

const LEGACY_INSTALL_CANDIDATES = [
  "C:\\Program Files (x86)\\Dark Basic Professional",
  "C:\\Program Files (x86)\\Dark-Basic-Pro",
  "C:\\Dark Basic Professional"
];

export async function resolveToolchain(): Promise<DarkBasicToolchain | undefined> {
  const config = vscode.workspace.getConfiguration("darkbasicNext");
  const explicitInstallRoot = config.get<string>("installRoot")?.trim();
  const discoveredInstallRoot = await resolveInstallRoot(explicitInstallRoot);
  if (!discoveredInstallRoot) {
    return undefined;
  }

  const compilerRoot = path.join(discoveredInstallRoot, "Compiler");
  const compilerExe = path.join(compilerRoot, "DBPCompiler.exe");
  if (!(await pathExists(compilerExe))) {
    return undefined;
  }

  const explicitDbnext = config.get<string>("dbnextPath")?.trim();
  const defaultDbnext = path.join(discoveredInstallRoot, "Tools", "dbnext.exe");
  const dbnextExe = explicitDbnext
    ? normalizeMaybePath(explicitDbnext)
    : (await pathExists(defaultDbnext) ? defaultDbnext : undefined);

  const tempSetting = config.get<string>("tempRoot")?.trim();
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const tempRoot = normalizeMaybePath(tempSetting) ?? path.join(localAppData, "DarkBASICNext", "temp");

  return {
    installRoot: discoveredInstallRoot,
    compilerRoot,
    compilerExe,
    toolsRoot: path.join(discoveredInstallRoot, "Tools"),
    dbnextExe,
    helpRoot: path.join(discoveredInstallRoot, "Help"),
    tempRoot
  };
}

async function resolveInstallRoot(explicitInstallRoot?: string): Promise<string | undefined> {
  const candidates: string[] = [];

  if (explicitInstallRoot) {
    candidates.push(explicitInstallRoot);
  }

  if (process.env.DBNEXT_ROOT) {
    candidates.push(process.env.DBNEXT_ROOT);
  }

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(workspaceFolder.uri.fsPath);
  }

  const activeDocumentPath = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activeDocumentPath) {
    candidates.push(path.dirname(activeDocumentPath));
  }

  candidates.push(...LEGACY_INSTALL_CANDIDATES);

  for (const candidate of candidates) {
    const normalized = normalizeMaybePath(candidate);
    if (!normalized) {
      continue;
    }

    for (const ancestor of enumerateAncestors(normalized)) {
      const directInstall = await normalizeInstallRoot(ancestor);
      if (directInstall) {
        return directInstall;
      }
    }
  }

  return undefined;
}

async function normalizeInstallRoot(candidate: string): Promise<string | undefined> {
  const fullCandidate = path.resolve(candidate);

  if (await isInstallRoot(fullCandidate)) {
    return fullCandidate;
  }

  const nestedInstall = path.join(fullCandidate, "Install");
  if (await isInstallRoot(nestedInstall)) {
    return nestedInstall;
  }

  return undefined;
}

async function isInstallRoot(candidate: string): Promise<boolean> {
  return await pathExists(path.join(candidate, "Launch.CFG")) &&
    await pathExists(path.join(candidate, "Compiler", "DBPCompiler.exe"));
}

function* enumerateAncestors(startPath: string): Generator<string> {
  let current = path.resolve(startPath);

  while (true) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }
}

function normalizeMaybePath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return path.resolve(value);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
