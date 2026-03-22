import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { DbProProject, ProjectSettings } from "./dbproProject";

const CURRENT_PROJECT_KEY = "darkbasicNext.currentProject";

export type BuildTarget =
  | { readonly kind: "project"; readonly project: DbProProject }
  | { readonly kind: "single-file"; readonly sourcePath: string };

export class ProjectService {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private currentProject: DbProProject | undefined;

  public readonly onDidChangeProject = this.changeEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async initialize(): Promise<void> {
    const savedProjectPath = this.context.workspaceState.get<string>(CURRENT_PROJECT_KEY);
    if (savedProjectPath && await pathExists(savedProjectPath)) {
      await this.loadProject(savedProjectPath, false);
      return;
    }

    await this.discoverWorkspaceProject();
  }

  public getCurrentProject(): DbProProject | undefined {
    return this.currentProject;
  }

  public async refreshCurrentProject(): Promise<void> {
    if (!this.currentProject) {
      return;
    }

    if (await pathExists(this.currentProject.filePath)) {
      this.currentProject = await DbProProject.load(this.currentProject.filePath);
      this.changeEmitter.fire();
    }
  }

  public async loadProject(filePath: string, persist = true): Promise<DbProProject> {
    const project = await DbProProject.load(filePath);
    this.currentProject = project;

    if (persist) {
      await this.context.workspaceState.update(CURRENT_PROJECT_KEY, filePath);
    }

    this.changeEmitter.fire();
    return project;
  }

  public async discoverWorkspaceProject(): Promise<DbProProject | undefined> {
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (activeDocument && isProjectDocument(activeDocument)) {
      return await this.loadProject(activeDocument.uri.fsPath);
    }

    const matches = await vscode.workspace.findFiles("**/*.dbpro", "**/{.git,node_modules}/**", 1);
    if (matches.length === 1) {
      return await this.loadProject(matches[0].fsPath);
    }

    return undefined;
  }

  public async resolveBuildTarget(): Promise<BuildTarget | undefined> {
    const activeDocument = vscode.window.activeTextEditor?.document;

    if (activeDocument && isProjectDocument(activeDocument)) {
      return {
        kind: "project",
        project: await this.loadProject(activeDocument.uri.fsPath)
      };
    }

    if (activeDocument && isSourceDocument(activeDocument)) {
      const existingProject = await this.resolveProjectForSource(activeDocument.uri.fsPath);
      if (existingProject) {
        return {
          kind: "project",
          project: existingProject
        };
      }

      return {
        kind: "single-file",
        sourcePath: activeDocument.uri.fsPath
      };
    }

    if (this.currentProject) {
      return {
        kind: "project",
        project: await this.loadProject(this.currentProject.filePath)
      };
    }

    const discoveredProject = await this.discoverWorkspaceProject();
    if (discoveredProject) {
      return {
        kind: "project",
        project: discoveredProject
      };
    }

    return undefined;
  }

  public async createNewProject(projectFolder: string, projectName: string): Promise<DbProProject> {
    const safeName = sanitizeFileStem(projectName);
    const mainFileName = `${safeName}.dba`;
    const projectFilePath = path.join(projectFolder, `${safeName}.dbpro`);
    const sourceFilePath = path.join(projectFolder, mainFileName);

    await fs.mkdir(projectFolder, { recursive: true });
    await fs.writeFile(
      sourceFilePath,
      "rem Project: DarkBASIC Next\r\n\r\nprint \"hello world\"\r\nend\r\n",
      "utf8"
    );

    const project = DbProProject.createTemplate(projectFilePath, projectName, mainFileName);
    await project.save();
    return await this.loadProject(projectFilePath);
  }

  public async saveCurrentProject(): Promise<void> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    await this.currentProject.save();
    this.changeEmitter.fire();
  }

  public async saveCurrentProjectAs(destinationPath: string): Promise<void> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    await this.currentProject.save(destinationPath);
    await this.loadProject(destinationPath);
  }

  public async addFile(fileName: string): Promise<string> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    const normalizedName = fileName.toLowerCase().endsWith(".dba") ? fileName : `${fileName}.dba`;
    const destinationPath = path.join(this.currentProject.directory, normalizedName);
    if (await pathExists(destinationPath)) {
      throw new Error(`Project file already exists: ${destinationPath}`);
    }

    await fs.writeFile(destinationPath, "rem Add DarkBASIC code here\r\n", "utf8");

    const sourceEntries = this.currentProject.getSourceEntries();
    const mainEntry = sourceEntries.find(entry => entry.kind === "main");
    const includeEntries = sourceEntries
      .filter(entry => entry.kind === "include")
      .map(entry => entry.relativePath);

    this.currentProject.setSources(mainEntry?.relativePath ?? normalizedName, [...includeEntries, normalizedName]);
    await this.currentProject.save();
    await this.refreshCurrentProject();
    return destinationPath;
  }

  public async importFiles(sourcePaths: readonly string[]): Promise<string[]> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    const importedRelativePaths: string[] = [];
    for (const sourcePath of sourcePaths) {
      const resolvedSource = path.resolve(sourcePath);
      let destinationPath = resolvedSource;

      if (!resolvedSource.toLowerCase().startsWith(this.currentProject.directory.toLowerCase())) {
        destinationPath = await copyIntoProject(this.currentProject.directory, resolvedSource);
      }

      importedRelativePaths.push(path.relative(this.currentProject.directory, destinationPath));
    }

    const sourceEntries = this.currentProject.getSourceEntries();
    const mainEntry = sourceEntries.find(entry => entry.kind === "main");
    const includeEntries = sourceEntries
      .filter(entry => entry.kind === "include")
      .map(entry => entry.relativePath);
    const nextIncludes = Array.from(new Set([...includeEntries, ...importedRelativePaths]));

    this.currentProject.setSources(mainEntry?.relativePath ?? importedRelativePaths[0] ?? "main.dba", nextIncludes);
    await this.currentProject.save();
    await this.refreshCurrentProject();

    return importedRelativePaths.map(relativePath => path.join(this.currentProject!.directory, relativePath));
  }

  public async setMainFile(filePath: string): Promise<void> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    const normalizedTarget = path.normalize(filePath).toLowerCase();
    const sourceEntries = this.currentProject.getSourceEntries();
    const matchingEntry = sourceEntries.find(entry =>
      path.normalize(path.resolve(this.currentProject!.directory, entry.relativePath)).toLowerCase() === normalizedTarget
    );

    if (!matchingEntry) {
      throw new Error("The selected file is not part of the current project.");
    }

    const includePaths = sourceEntries
      .map(entry => entry.relativePath)
      .filter(relativePath =>
        path.normalize(path.resolve(this.currentProject!.directory, relativePath)).toLowerCase() !== normalizedTarget
      );

    this.currentProject.setSources(matchingEntry.relativePath, includePaths);
    await this.currentProject.save();
    await this.refreshCurrentProject();
  }

  public async updateProjectSettings(settings: Partial<ProjectSettings>): Promise<void> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    this.currentProject.updateProjectSettings(settings);
    await this.currentProject.save();
    await this.refreshCurrentProject();
  }

  public async addTodo(text: string): Promise<void> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    this.currentProject.addTodoEntry(text);
    await this.currentProject.save();
    await this.refreshCurrentProject();
  }

  public async addComment(text: string): Promise<void> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    this.currentProject.addCommentEntry(text);
    await this.currentProject.save();
    await this.refreshCurrentProject();
  }

  public async addMediaFiles(sourcePaths: readonly string[]): Promise<string[]> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    const project = this.currentProject;
    const destinationDirectory = path.join(project.directory, "media");
    await fs.mkdir(destinationDirectory, { recursive: true });

    const imported: string[] = [];
    for (const sourcePath of sourcePaths) {
      const destinationPath = await copyIntoDirectory(destinationDirectory, sourcePath);
      const relativePath = path.relative(project.directory, destinationPath);
      project.addMediaEntry(relativePath);
      imported.push(destinationPath);
    }

    await project.save();
    await this.refreshCurrentProject();
    return imported;
  }

  public async setIconFile(sourcePath: string): Promise<string> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    const project = this.currentProject;
    const destinationPath = await copyIntoDirectory(project.directory, sourcePath);
    project.setIconEntry(path.relative(project.directory, destinationPath));
    await project.save();
    await this.refreshCurrentProject();
    return destinationPath;
  }

  public async setCursorFile(slotKey: string, sourcePath: string): Promise<string> {
    if (!this.currentProject) {
      throw new Error("No DarkBASIC project is currently loaded.");
    }

    const project = this.currentProject;
    const destinationDirectory = path.join(project.directory, "cursors");
    await fs.mkdir(destinationDirectory, { recursive: true });
    const destinationPath = await copyIntoDirectory(destinationDirectory, sourcePath);
    project.setCursorEntry(slotKey, path.relative(project.directory, destinationPath));
    await project.save();
    await this.refreshCurrentProject();
    return destinationPath;
  }

  private async resolveProjectForSource(sourcePath: string): Promise<DbProProject | undefined> {
    if (this.currentProject && this.currentProject.containsSource(sourcePath)) {
      return await this.loadProject(this.currentProject.filePath);
    }

    const projectFiles = await vscode.workspace.findFiles("**/*.dbpro", "**/{.git,node_modules}/**");
    for (const projectFile of projectFiles) {
      const candidate = await DbProProject.load(projectFile.fsPath);
      if (candidate.containsSource(sourcePath)) {
        this.currentProject = candidate;
        await this.context.workspaceState.update(CURRENT_PROJECT_KEY, candidate.filePath);
        this.changeEmitter.fire();
        return candidate;
      }
    }

    return undefined;
  }
}

function isProjectDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && document.fileName.toLowerCase().endsWith(".dbpro");
}

function isSourceDocument(document: vscode.TextDocument): boolean {
  const lower = document.fileName.toLowerCase();
  return document.uri.scheme === "file" && (lower.endsWith(".dba") || lower.endsWith(".dbsource"));
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[<>:\"/\\|?*\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim() || "DarkBASIC Project";
}

async function copyIntoProject(projectDirectory: string, sourcePath: string): Promise<string> {
  return await copyIntoDirectory(projectDirectory, sourcePath);
}

async function copyIntoDirectory(destinationDirectory: string, sourcePath: string): Promise<string> {
  const parsed = path.parse(sourcePath);
  let attempt = 0;

  while (true) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidatePath = path.join(destinationDirectory, `${parsed.name}${suffix}${parsed.ext}`);
    if (!(await pathExists(candidatePath))) {
      await fs.copyFile(sourcePath, candidatePath);
      return candidatePath;
    }

    attempt += 1;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
