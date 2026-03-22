import * as path from "node:path";
import * as vscode from "vscode";
import { DbProProject } from "./dbproProject";
import { ProjectService } from "./projectService";
import { resolveToolchain } from "./toolchain";

interface DarkBasicTaskDefinition extends vscode.TaskDefinition {
  readonly action: "compile" | "run";
  readonly project?: string;
}

export class DarkBasicTaskProvider implements vscode.TaskProvider {
  public constructor(private readonly projectService: ProjectService) {}

  public async provideTasks(): Promise<vscode.Task[]> {
    if (process.platform !== "win32") {
      return [];
    }

    const toolchain = await resolveToolchain();
    if (!toolchain) {
      return [];
    }

    const project = await this.resolveProject();
    if (!project) {
      return [];
    }

    return [
      this.createTask(project, toolchain.compilerExe, "compile"),
      this.createTask(project, toolchain.compilerExe, "run")
    ];
  }

  public async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
    if (process.platform !== "win32") {
      return undefined;
    }

    const definition = task.definition as DarkBasicTaskDefinition;
    const toolchain = await resolveToolchain();
    if (!toolchain) {
      return undefined;
    }

    const project = definition.project
      ? await DbProProject.load(path.resolve(definition.project))
      : await this.resolveProject();

    if (!project) {
      return undefined;
    }

    return this.createTask(project, toolchain.compilerExe, definition.action);
  }

  private async resolveProject(): Promise<DbProProject | undefined> {
    const currentProject = this.projectService.getCurrentProject();
    if (currentProject) {
      return currentProject;
    }

    return await this.projectService.discoverWorkspaceProject();
  }

  private createTask(project: DbProProject, compilerExe: string, action: "compile" | "run"): vscode.Task {
    const definition: DarkBasicTaskDefinition = {
      type: "darkbasic-next",
      action,
      project: project.filePath
    };

    const projectFileName = path.basename(project.filePath);
    const projectDirectory = project.directory;
    const outputExecutable = project.getExecutable();
    const absoluteExecutable = path.isAbsolute(outputExecutable)
      ? outputExecutable
      : path.resolve(projectDirectory, outputExecutable);
    const executableDirectory = path.dirname(absoluteExecutable);

    const command = action === "compile"
      ? `& '${escapePowerShell(compilerExe)}' '${escapePowerShell(projectFileName)}'`
      : `& '${escapePowerShell(compilerExe)}' '${escapePowerShell(projectFileName)}'; if ($LASTEXITCODE -eq 0) { Start-Process -FilePath '${escapePowerShell(absoluteExecutable)}' -WorkingDirectory '${escapePowerShell(executableDirectory)}' } exit $LASTEXITCODE`;

    const execution = new vscode.ShellExecution("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command
    ], {
      cwd: projectDirectory
    });

    const task = new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      action === "compile" ? `Compile ${project.getProjectName()}` : `Run ${project.getProjectName()}`,
      "DarkBASIC Next",
      execution
    );

    task.group = action === "compile" ? vscode.TaskGroup.Build : vscode.TaskGroup.Test;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Shared,
      clear: false
    };

    return task;
  }
}

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}
