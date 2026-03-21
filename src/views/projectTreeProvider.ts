import * as path from "node:path";
import * as vscode from "vscode";
import { ProjectService } from "../services/projectService";

export class ProjectTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly filePath: string,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    contextValue: string,
    description?: string
  ) {
    super(label, collapsibleState);
    this.resourceUri = filePath ? vscode.Uri.file(filePath) : undefined;
    this.contextValue = contextValue;
    this.description = description;
  }
}

export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<ProjectTreeItem | undefined | void>();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly projectService: ProjectService) {
    this.projectService.onDidChangeProject(() => {
      this.refresh();
    });
  }

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public getTreeItem(element: ProjectTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ProjectTreeItem): Promise<ProjectTreeItem[]> {
    const project = this.projectService.getCurrentProject();
    if (!project) {
      return [
        new ProjectTreeItem(
          "",
          "Open or create a .dbpro project",
          vscode.TreeItemCollapsibleState.None,
          "darkbasicMessage"
        )
      ];
    }

    if (!element) {
      const root = new ProjectTreeItem(
        project.filePath,
        project.getProjectName(),
        vscode.TreeItemCollapsibleState.Expanded,
        "darkbasicProject",
        path.basename(project.filePath)
      );
      root.iconPath = new vscode.ThemeIcon("project");
      return [root];
    }

    if (element.contextValue === "darkbasicProject") {
      return project.getSourceEntries().map(entry => {
        const absolutePath = path.resolve(project.directory, entry.relativePath);
        const item = new ProjectTreeItem(
          absolutePath,
          path.basename(entry.relativePath),
          vscode.TreeItemCollapsibleState.None,
          "darkbasicFile",
          entry.kind === "main" ? "main" : "include"
        );
        item.command = {
          command: "darkbasicNext.project.openItem",
          title: "Open",
          arguments: [item]
        };
        item.iconPath = new vscode.ThemeIcon(entry.kind === "main" ? "play" : "file-code");
        return item;
      });
    }

    return [];
  }
}
