import * as vscode from "vscode";
import { DbNextClient, InstalledPackageRecord } from "../services/dbnextClient";
import { resolveToolchain } from "../services/toolchain";

export class PackageTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly packageId: string,
    label: string,
    description?: string,
    contextValue = "darkbasicPackage"
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = contextValue;
  }
}

export class PackagesTreeProvider implements vscode.TreeDataProvider<PackageTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<PackageTreeItem | undefined | void>();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly dbnextClient: DbNextClient) {}

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public getTreeItem(element: PackageTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<PackageTreeItem[]> {
    const toolchain = await resolveToolchain();
    if (!toolchain) {
      return [
        new PackageTreeItem(
          "",
          "DarkBASIC toolchain not found",
          "Set darkbasicNext.installRoot",
          "darkbasicMessage"
        )
      ];
    }

    if (!toolchain.dbnextExe) {
      return [
        new PackageTreeItem(
          "",
          "dbnext.exe not found",
          "Set darkbasicNext.dbnextPath",
          "darkbasicMessage"
        )
      ];
    }

    try {
      const installedPackages = await this.dbnextClient.listInstalled(toolchain);
      if (installedPackages.length === 0) {
        return [
          new PackageTreeItem(
            "",
            "No packages installed",
            "Use DarkBASIC Next: Search Packages",
            "darkbasicMessage"
          )
        ];
      }

      return installedPackages
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(record => createPackageItem(record));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        new PackageTreeItem("", "Failed to load packages", message, "darkbasicMessage")
      ];
    }
  }
}

function createPackageItem(record: InstalledPackageRecord): PackageTreeItem {
  const item = new PackageTreeItem(record.id, record.id, record.version);
  item.tooltip = `${record.id} ${record.version}\n${record.sourceName}`;
  item.iconPath = new vscode.ThemeIcon("package");
  item.command = {
    command: "darkbasicNext.package.update",
    title: "Update Package",
    arguments: [record.id]
  };
  return item;
}
