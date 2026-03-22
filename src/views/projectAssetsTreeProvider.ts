import * as path from "node:path";
import * as vscode from "vscode";
import { CursorEntry, ProjectSettings } from "../services/dbproProject";
import { ProjectService } from "../services/projectService";

type AssetSectionKind = "properties" | "media" | "cursors" | "todo" | "comments";

export class ProjectAssetTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly kind: "message" | "section" | "property" | "file" | "todo" | "comment",
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly payload?: string,
    public readonly section?: AssetSectionKind,
    description?: string
  ) {
    super(label, collapsibleState);
    this.description = description;

    this.contextValue = kind === "file"
      ? "darkbasicAssetFile"
      : kind === "property"
        ? "darkbasicAssetProperty"
        : kind === "todo"
          ? "darkbasicAssetTodo"
          : kind === "comment"
            ? "darkbasicAssetComment"
            : "darkbasicAssetSection";
  }
}

export class ProjectAssetsTreeProvider implements vscode.TreeDataProvider<ProjectAssetTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<ProjectAssetTreeItem | undefined | void>();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly projectService: ProjectService) {
    this.projectService.onDidChangeProject(() => {
      this.refresh();
    });
  }

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public getTreeItem(element: ProjectAssetTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ProjectAssetTreeItem): Promise<ProjectAssetTreeItem[]> {
    const project = this.projectService.getCurrentProject();
    if (!project) {
      return [
        new ProjectAssetTreeItem(
          "message",
          "Open or create a .dbpro project",
          vscode.TreeItemCollapsibleState.None
        )
      ];
    }

    if (!element) {
      return [
        createSection("Properties", "properties", "settings-gear"),
        createSection("Media", "media", "files"),
        createSection("Cursors", "cursors", "symbol-color"),
        createSection("TODO", "todo", "checklist"),
        createSection("Comments", "comments", "comment")
      ];
    }

    switch (element.section) {
      case "properties":
        return createPropertyItems(project.getProjectSettings());
      case "media":
        return createFileItems(project.directory, project.getMediaEntries(), "Media");
      case "cursors":
        return createCursorItems(project.directory, project.getCursorEntries());
      case "todo":
        return createTextItems(project.getTodoEntries(), "todo");
      case "comments":
        return createTextItems(project.getCommentEntries(), "comment");
      default:
        return [];
    }
  }
}

function createSection(label: string, section: AssetSectionKind, iconId: string): ProjectAssetTreeItem {
  const item = new ProjectAssetTreeItem(
    "section",
    label,
    vscode.TreeItemCollapsibleState.Expanded,
    undefined,
    section
  );
  item.iconPath = new vscode.ThemeIcon(iconId);
  return item;
}

function createPropertyItems(settings: ProjectSettings): ProjectAssetTreeItem[] {
  return [
    createPropertyItem("App Title", settings.appTitle),
    createPropertyItem("Executable", settings.executable),
    createPropertyItem("Graphics Mode", settings.graphicsMode),
    createPropertyItem("Window Resolution", settings.windowResolution),
    createPropertyItem("Fullscreen Resolution", settings.fullscreenResolution),
    createPropertyItem("Command Line Args", settings.commandLineArguments || "(none)"),
    createPropertyItem("Icon", settings.icon || "(none)")
  ];
}

function createPropertyItem(label: string, value: string): ProjectAssetTreeItem {
  const item = new ProjectAssetTreeItem(
    "property",
    label,
    vscode.TreeItemCollapsibleState.None,
    value,
    "properties",
    value
  );
  item.iconPath = new vscode.ThemeIcon("symbol-property");
  return item;
}

function createFileItems(projectDirectory: string, values: readonly string[], fallbackLabel: string): ProjectAssetTreeItem[] {
  if (values.length === 0) {
    return [
      new ProjectAssetTreeItem("message", `No ${fallbackLabel.toLowerCase()} entries`, vscode.TreeItemCollapsibleState.None)
    ];
  }

  return values.map(value => createFileItem(projectDirectory, value));
}

function createCursorItems(projectDirectory: string, values: readonly CursorEntry[]): ProjectAssetTreeItem[] {
  if (values.length === 0) {
    return [
      new ProjectAssetTreeItem("message", "No cursor entries", vscode.TreeItemCollapsibleState.None)
    ];
  }

  return values.map(entry => createFileItem(projectDirectory, entry.value, entry.label));
}

function createFileItem(projectDirectory: string, relativePath: string, labelOverride?: string): ProjectAssetTreeItem {
  const absolutePath = path.resolve(projectDirectory, relativePath);
  const item = new ProjectAssetTreeItem(
    "file",
    labelOverride ?? path.basename(relativePath),
    vscode.TreeItemCollapsibleState.None,
    absolutePath,
    undefined,
    relativePath
  );
  item.resourceUri = vscode.Uri.file(absolutePath);
  item.iconPath = new vscode.ThemeIcon("file");
  item.command = {
    command: "darkbasicNext.assets.openFile",
    title: "Open Asset",
    arguments: [item]
  };
  return item;
}

function createTextItems(values: readonly string[], kind: "todo" | "comment"): ProjectAssetTreeItem[] {
  if (values.length === 0) {
    return [
      new ProjectAssetTreeItem("message", `No ${kind} entries`, vscode.TreeItemCollapsibleState.None)
    ];
  }

  return values.map((value, index) => {
    const item = new ProjectAssetTreeItem(
      kind,
      `${index + 1}. ${value}`,
      vscode.TreeItemCollapsibleState.None,
      value
    );
    item.iconPath = new vscode.ThemeIcon(kind === "todo" ? "check" : "comment");
    return item;
  });
}
