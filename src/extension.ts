import * as path from "node:path";
import * as vscode from "vscode";
import { registerDarkBasicLanguageProviders, resolveHelpEntryFromEditor } from "./language/darkbasicLanguageProviders";
import { CompilerService } from "./services/compilerService";
import { DarkBasicTaskProvider } from "./services/darkbasicTaskProvider";
import { DbNextClient, ResolvedPackage } from "./services/dbnextClient";
import { HelpIndex } from "./services/helpIndex";
import { ProjectService } from "./services/projectService";
import { resolveToolchain } from "./services/toolchain";
import { ProjectAssetTreeItem, ProjectAssetsTreeProvider } from "./views/projectAssetsTreeProvider";
import { PackagesTreeProvider, PackageTreeItem } from "./views/packagesTreeProvider";
import { ProjectTreeItem, ProjectTreeProvider } from "./views/projectTreeProvider";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("DarkBASIC Next");
  const diagnostics = vscode.languages.createDiagnosticCollection("darkbasic-next");
  const projectService = new ProjectService(context);
  await projectService.initialize();

  const compilerService = new CompilerService(output, diagnostics, projectService);
  const taskProvider = new DarkBasicTaskProvider(projectService);
  const dbnextClient = new DbNextClient(output);
  const helpIndex = new HelpIndex(output);
  const projectTreeProvider = new ProjectTreeProvider(projectService);
  const projectAssetsTreeProvider = new ProjectAssetsTreeProvider(projectService);
  const packagesTreeProvider = new PackagesTreeProvider(dbnextClient);

  registerDarkBasicLanguageProviders(context, helpIndex);

  context.subscriptions.push(
    output,
    diagnostics,
    vscode.tasks.registerTaskProvider("darkbasic-next", taskProvider),
    vscode.window.registerTreeDataProvider("darkbasicNext.project", projectTreeProvider),
    vscode.window.registerTreeDataProvider("darkbasicNext.assets", projectAssetsTreeProvider),
    vscode.window.registerTreeDataProvider("darkbasicNext.packages", packagesTreeProvider),
    vscode.workspace.onDidSaveTextDocument(async document => {
      const lower = document.fileName.toLowerCase();
      if (lower.endsWith(".dbpro")) {
        await projectService.refreshCurrentProject();
        projectAssetsTreeProvider.refresh();
      }

      if (lower.endsWith(".dba") || lower.endsWith(".dbsource")) {
        projectTreeProvider.refresh();
      }
    }),
    vscode.commands.registerCommand("darkbasicNext.newProject", async () => {
      const location = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Create Project Here"
      });
      if (!location?.[0]) {
        return;
      }

      const projectName = await vscode.window.showInputBox({
        prompt: "DarkBASIC project name",
        placeHolder: "Hello World",
        validateInput: value => value.trim().length === 0 ? "Enter a project name." : undefined
      });
      if (!projectName) {
        return;
      }

      const projectFolder = path.join(location[0].fsPath, projectName.trim());
      const project = await projectService.createNewProject(projectFolder, projectName.trim());
      await openFile(project.filePath);
      const mainSource = project.getAbsoluteSourcePaths()[0];
      if (mainSource) {
        await openFile(mainSource);
      }

      projectTreeProvider.refresh();
      projectAssetsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.openProject", async () => {
      const selection = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          "DarkBASIC Project": ["dbpro"]
        }
      });

      if (!selection?.[0]) {
        return;
      }

      await projectService.loadProject(selection[0].fsPath);
      await openFile(selection[0].fsPath);
      projectTreeProvider.refresh();
      projectAssetsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.saveProject", async () => {
      await projectService.saveCurrentProject();
      vscode.window.showInformationMessage("DarkBASIC project saved.");
    }),
    vscode.commands.registerCommand("darkbasicNext.saveProjectAs", async () => {
      const currentProject = projectService.getCurrentProject();
      if (!currentProject) {
        vscode.window.showErrorMessage("No DarkBASIC project is currently loaded.");
        return;
      }

      const destination = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(currentProject.filePath),
        filters: {
          "DarkBASIC Project": ["dbpro"]
        }
      });

      if (!destination) {
        return;
      }

      await projectService.saveCurrentProjectAs(destination.fsPath);
      projectTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.addFile", async () => {
      const fileName = await vscode.window.showInputBox({
        prompt: "New DarkBASIC file name",
        placeHolder: "gameplay.dba",
        validateInput: value => value.trim().length === 0 ? "Enter a file name." : undefined
      });
      if (!fileName) {
        return;
      }

      const filePath = await projectService.addFile(fileName.trim());
      await openFile(filePath);
      projectTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.importFile", async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        filters: {
          "DarkBASIC Source": ["dba", "dbsource"]
        }
      });

      if (!files?.length) {
        return;
      }

      await projectService.importFiles(files.map(file => file.fsPath));
      projectTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.setMainFile", async (item?: ProjectTreeItem) => {
      let targetPath = item?.filePath;
      if (!targetPath) {
        const editorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (editorPath) {
          targetPath = editorPath;
        }
      }

      if (!targetPath) {
        vscode.window.showErrorMessage("Open a project source file or select one in the Project view first.");
        return;
      }

      await projectService.setMainFile(targetPath);
      projectTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.project.editProperties", async () => {
      const project = projectService.getCurrentProject();
      if (!project) {
        vscode.window.showErrorMessage("No DarkBASIC project is currently loaded.");
        return;
      }

      const current = project.getProjectSettings();
      const propertyPick = await vscode.window.showQuickPick([
        { label: "App Title", value: "appTitle", current: current.appTitle },
        { label: "Executable", value: "executable", current: current.executable },
        { label: "Graphics Mode", value: "graphicsMode", current: current.graphicsMode },
        { label: "Window Resolution", value: "windowResolution", current: current.windowResolution },
        { label: "Fullscreen Resolution", value: "fullscreenResolution", current: current.fullscreenResolution },
        { label: "Command Line Args", value: "commandLineArguments", current: current.commandLineArguments }
      ], {
        placeHolder: "Select a project property to edit"
      });

      if (!propertyPick) {
        return;
      }

      let nextValue = propertyPick.current;
      if (propertyPick.value === "graphicsMode") {
        const modePick = await vscode.window.showQuickPick([
          "window",
          "fullscreen",
          "desktop",
          "fulldesktop",
          "hidden"
        ], {
          placeHolder: "Select a graphics mode"
        });
        if (!modePick) {
          return;
        }
        nextValue = modePick;
      } else {
        const input = await vscode.window.showInputBox({
          prompt: `Set ${propertyPick.label}`,
          value: propertyPick.current
        });
        if (input === undefined) {
          return;
        }
        nextValue = input;
      }

      await projectService.updateProjectSettings({
        [propertyPick.value]: nextValue
      });
      projectAssetsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.project.addMedia", async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: "Add Media"
      });
      if (!files?.length) {
        return;
      }

      await projectService.addMediaFiles(files.map(file => file.fsPath));
      projectAssetsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.project.addTodo", async () => {
      const value = await vscode.window.showInputBox({
        prompt: "Add a project TODO item"
      });
      if (!value) {
        return;
      }

      await projectService.addTodo(value);
      projectAssetsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.project.addComment", async () => {
      const value = await vscode.window.showInputBox({
        prompt: "Add a project comment"
      });
      if (!value) {
        return;
      }

      await projectService.addComment(value);
      projectAssetsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.project.setIcon", async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          "Icon": ["ico"]
        },
        openLabel: "Set Project Icon"
      });
      if (!files?.[0]) {
        return;
      }

      await projectService.setIconFile(files[0].fsPath);
      projectAssetsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.project.setCursor", async () => {
      const slot = await vscode.window.showQuickPick([
        { label: "Arrow Cursor", value: "cursorarrow" },
        { label: "Wait Cursor", value: "cursorwait" },
        { label: "Pointer 2", value: "pointer2" },
        { label: "Pointer 3", value: "pointer3" },
        { label: "Pointer 4", value: "pointer4" },
        { label: "Pointer 5", value: "pointer5" }
      ], {
        placeHolder: "Select a project cursor slot"
      });
      if (!slot) {
        return;
      }

      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          "Cursor": ["cur", "ani", "bmp", "png", "ico"]
        },
        openLabel: "Set Project Cursor"
      });
      if (!files?.[0]) {
        return;
      }

      await projectService.setCursorFile(slot.value, files[0].fsPath);
      projectAssetsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.compile", async () => {
      await compilerService.execute(await resolveToolchain(), "compile");
    }),
    vscode.commands.registerCommand("darkbasicNext.run", async () => {
      await compilerService.execute(await resolveToolchain(), "run");
    }),
    vscode.commands.registerCommand("darkbasicNext.debug", async () => {
      await compilerService.execute(await resolveToolchain(), "debug");
    }),
    vscode.commands.registerCommand("darkbasicNext.step", async () => {
      await compilerService.execute(await resolveToolchain(), "step");
    }),
    vscode.commands.registerCommand("darkbasicNext.runPrevious", async () => {
      await compilerService.runPrevious();
    }),
    vscode.commands.registerCommand("darkbasicNext.package.search", async () => {
      const toolchain = await resolveToolchain();
      if (!toolchain) {
        vscode.window.showErrorMessage("DarkBASIC toolchain not found.");
        return;
      }

      const query = await vscode.window.showInputBox({
        prompt: "Search DarkBASIC packages",
        placeHolder: "ode, darkphysics, lua"
      });
      if (query === undefined) {
        return;
      }

      const results = await dbnextClient.search(toolchain, query);
      const pick = await vscode.window.showQuickPick(
        results.map(result => toQuickPick(result)),
        {
          matchOnDescription: true,
          matchOnDetail: true,
          placeHolder: "Select a package to install"
        }
      );

      if (!pick) {
        return;
      }

      const response = await dbnextClient.install(toolchain, pick.packageResult.manifest.id);
      packagesTreeProvider.refresh();
      vscode.window.showInformationMessage(response.trim() || `Installed ${pick.packageResult.manifest.id}.`);
    }),
    vscode.commands.registerCommand("darkbasicNext.package.install", async (packageIdOrItem?: string | PackageTreeItem) => {
      const toolchain = await resolveToolchain();
      if (!toolchain) {
        vscode.window.showErrorMessage("DarkBASIC toolchain not found.");
        return;
      }

      const packageId =
        typeof packageIdOrItem === "string"
          ? packageIdOrItem
          : packageIdOrItem instanceof PackageTreeItem
            ? packageIdOrItem.packageId
            : await vscode.window.showInputBox({
                prompt: "Package id to install"
              });

      if (!packageId) {
        return;
      }

      const response = await dbnextClient.install(toolchain, packageId);
      packagesTreeProvider.refresh();
      vscode.window.showInformationMessage(response.trim() || `Installed ${packageId}.`);
    }),
    vscode.commands.registerCommand("darkbasicNext.package.update", async (packageIdOrItem?: string | PackageTreeItem) => {
      const toolchain = await resolveToolchain();
      if (!toolchain) {
        vscode.window.showErrorMessage("DarkBASIC toolchain not found.");
        return;
      }

      const packageId =
        typeof packageIdOrItem === "string"
          ? packageIdOrItem
          : packageIdOrItem instanceof PackageTreeItem
            ? packageIdOrItem.packageId
            : undefined;

      const response = await dbnextClient.update(toolchain, packageId);
      packagesTreeProvider.refresh();
      vscode.window.showInformationMessage(response.trim() || "Packages updated.");
    }),
    vscode.commands.registerCommand("darkbasicNext.package.doctor", async () => {
      const toolchain = await resolveToolchain();
      if (!toolchain) {
        vscode.window.showErrorMessage("DarkBASIC toolchain not found.");
        return;
      }

      const report = await dbnextClient.doctor(toolchain);
      const summary = report.checks
        .map(check => `${check.passed ? "OK" : "FAIL"} ${check.name}: ${check.message}`)
        .join("\n");
      output.appendLine(summary);
      vscode.window.showInformationMessage(`dbnext doctor checked ${report.checks.length} item(s). See the DarkBASIC Next output panel for details.`);
    }),
    vscode.commands.registerCommand("darkbasicNext.openHelp", async () => {
      const toolchain = await resolveToolchain();
      if (!toolchain) {
        vscode.window.showErrorMessage("DarkBASIC toolchain not found.");
        return;
      }

      const editor = vscode.window.activeTextEditor;
      const matchedEntry = await resolveHelpEntryFromEditor(helpIndex, editor);
      if (matchedEntry) {
        await vscode.env.openExternal(vscode.Uri.file(path.normalize(matchedEntry.helpAbsolutePath)));
        return;
      }

      const selectionText = editor?.document.getText(editor.selection).trim();
      if (selectionText) {
        const results = await helpIndex.search(toolchain, selectionText);
        if (results.length > 0) {
          const pick = await vscode.window.showQuickPick(
            results.slice(0, 50).map(entry => ({
              label: entry.command,
              description: entry.signature,
              detail: entry.helpRelativePath,
              entry
            })),
            {
              placeHolder: "Select a DarkBASIC help topic"
            }
          );

          if (pick) {
            await vscode.env.openExternal(vscode.Uri.file(path.normalize(pick.entry.helpAbsolutePath)));
            return;
          }
        }
      }

      const helpEntry = vscode.Uri.file(path.join(toolchain.helpRoot, "main.htm"));
      await vscode.env.openExternal(helpEntry);
    }),
    vscode.commands.registerCommand("darkbasicNext.project.refresh", async () => {
      await projectService.refreshCurrentProject();
      projectTreeProvider.refresh();
      projectAssetsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.assets.refresh", async () => {
      await projectService.refreshCurrentProject();
      projectAssetsTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.packages.refresh", () => {
      packagesTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("darkbasicNext.project.openItem", async (item?: ProjectTreeItem) => {
      if (!item?.filePath) {
        return;
      }

      await openFile(item.filePath);
    }),
    vscode.commands.registerCommand("darkbasicNext.assets.openFile", async (item?: ProjectAssetTreeItem) => {
      if (!item?.payload) {
        return;
      }

      await openFile(item.payload);
    })
  );
}

export function deactivate(): void {}

async function openFile(filePath: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

function toQuickPick(packageResult: ResolvedPackage): vscode.QuickPickItem & { packageResult: ResolvedPackage } {
  return {
    label: packageResult.manifest.displayName,
    description: `${packageResult.manifest.id} ${packageResult.manifest.version}`,
    detail: packageResult.manifest.summary,
    packageResult
  };
}
