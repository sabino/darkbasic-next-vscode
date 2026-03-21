import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { DbProProject } from "./dbproProject";
import { ProjectService, BuildTarget } from "./projectService";
import { DarkBasicToolchain } from "./toolchain";

export type BuildMode = "compile" | "run" | "debug" | "step";

interface BuildLineMapEntry {
  readonly sourcePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

interface BuildSession {
  readonly workingDirectory: string;
  readonly projectFilePath: string;
  readonly outputExePath: string;
  readonly errorReportPath: string;
  readonly lineMap: readonly BuildLineMapEntry[];
  readonly primarySourcePath: string;
}

export class CompilerService {
  private lastExecutablePath: string | undefined;

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly projectService: ProjectService
  ) {}

  public async execute(toolchain: DarkBasicToolchain | undefined, mode: BuildMode): Promise<void> {
    if (process.platform !== "win32") {
      vscode.window.showErrorMessage("DarkBASIC compile and run commands are currently supported only on Windows.");
      return;
    }

    if (!toolchain) {
      vscode.window.showErrorMessage(
        "Could not locate a DarkBASIC toolchain. Configure darkbasicNext.installRoot or open a workspace that contains an Install directory."
      );
      return;
    }

    if (mode === "debug" || mode === "step") {
      vscode.window.showWarningMessage(
        "The legacy DBPro debugger bridge is not implemented in the VS Code extension yet. Compile and run are available; debug and step are still pending."
      );
      return;
    }

    await vscode.workspace.saveAll(false);
    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine(`=== DarkBASIC ${mode.toUpperCase()} ===`);
    this.diagnostics.clear();

    const buildTarget = await this.projectService.resolveBuildTarget();
    if (!buildTarget) {
      vscode.window.showErrorMessage("Open a .dbpro project or a .dba source file before compiling.");
      return;
    }

    const session = await this.prepareBuildSession(toolchain, buildTarget, mode);
    const success = await this.runCompiler(toolchain, session);
    if (!success) {
      return;
    }

    this.lastExecutablePath = session.outputExePath;
    this.output.appendLine(`Built ${session.outputExePath}`);

    if (mode === "run") {
      await this.launchExecutable(session.outputExePath);
    }
  }

  public async runPrevious(): Promise<void> {
    if (!this.lastExecutablePath) {
      vscode.window.showInformationMessage("No previous DarkBASIC build is available yet.");
      return;
    }

    await this.launchExecutable(this.lastExecutablePath);
  }

  private async prepareBuildSession(
    toolchain: DarkBasicToolchain,
    buildTarget: BuildTarget,
    mode: Exclude<BuildMode, "debug" | "step">
  ): Promise<BuildSession> {
    const sessionRoot = path.join(toolchain.tempRoot, "builds", formatTimestamp(new Date()));
    await fs.mkdir(sessionRoot, { recursive: true });
    await fs.mkdir(path.join(toolchain.installRoot, "Temp"), { recursive: true });

    if (buildTarget.kind === "single-file") {
      return await this.prepareSingleFileSession(toolchain, buildTarget.sourcePath, sessionRoot, mode);
    }

    return await this.prepareProjectSession(toolchain, buildTarget.project, sessionRoot, mode);
  }

  private async prepareProjectSession(
    toolchain: DarkBasicToolchain,
    project: DbProProject,
    sessionRoot: string,
    mode: Exclude<BuildMode, "debug" | "step">
  ): Promise<BuildSession> {
    const sourceEntries = project.getSourceEntries();
    if (sourceEntries.length === 0) {
      throw new Error(`The project '${project.filePath}' does not define any source files.`);
    }

    const stagedProject = project.cloneTo(path.join(sessionRoot, "Temp.dbpro"));
    const lineMap: BuildLineMapEntry[] = [];
    let combinedSource = "";
    let currentGeneratedLine = 1;

    for (const sourceEntry of sourceEntries) {
      const sourcePath = path.resolve(project.directory, sourceEntry.relativePath);
      const sourceText = normalizeLineEndings(await fs.readFile(sourcePath, "utf8"));
      const stagedSourcePath = path.join(sessionRoot, sourceEntry.relativePath);

      await fs.mkdir(path.dirname(stagedSourcePath), { recursive: true });
      await fs.writeFile(stagedSourcePath, sourceText, "utf8");

      const lineCount = countLines(sourceText);
      lineMap.push({
        sourcePath,
        startLine: currentGeneratedLine,
        endLine: currentGeneratedLine + lineCount - 1
      });

      combinedSource += sourceText;
      if (!combinedSource.endsWith("\r\n")) {
        combinedSource += "\r\n";
      }
      currentGeneratedLine += lineCount + 1;
    }

    const executableName = path.basename(stagedProject.getExecutable()) || "Application.exe";
    stagedProject.setSources(sourceEntries[0].relativePath, sourceEntries.slice(1).map(entry => entry.relativePath));
    stagedProject.setValue("final source", "_Temp.dbsource");
    stagedProject.setValue("executable", path.join(sessionRoot, executableName));
    stagedProject.setValue("CLI", mode === "compile" ? "NO" : "NO");
    stagedProject.setValue("media root path", ensureTrailingSlash(project.directory));

    const projectFilePath = path.join(sessionRoot, "Temp.dbpro");
    const finalSourcePath = path.join(sessionRoot, "_Temp.dbsource");
    await fs.writeFile(finalSourcePath, combinedSource, "utf8");
    await stagedProject.save(projectFilePath);

    return {
      workingDirectory: sessionRoot,
      projectFilePath,
      outputExePath: path.join(sessionRoot, executableName),
      errorReportPath: path.join(toolchain.installRoot, "Temp", "ErrorReport.txt"),
      lineMap,
      primarySourcePath: path.resolve(project.directory, sourceEntries[0].relativePath)
    };
  }

  private async prepareSingleFileSession(
    toolchain: DarkBasicToolchain,
    sourcePath: string,
    sessionRoot: string,
    mode: Exclude<BuildMode, "debug" | "step">
  ): Promise<BuildSession> {
    const sourceText = normalizeLineEndings(await fs.readFile(sourcePath, "utf8"));
    const sourceFileName = path.basename(sourcePath);
    const executableName = `${path.parse(sourceFileName).name}.exe`;
    const projectFilePath = path.join(sessionRoot, "Temp.dbpro");
    const stagedSourcePath = path.join(sessionRoot, sourceFileName);
    const finalSourcePath = path.join(sessionRoot, "_Temp.dbsource");
    const project = DbProProject.createTemplate(projectFilePath, path.parse(sourceFileName).name, sourceFileName);

    await fs.writeFile(stagedSourcePath, sourceText, "utf8");
    await fs.writeFile(finalSourcePath, sourceText, "utf8");

    project.setValue("final source", "_Temp.dbsource");
    project.setValue("executable", path.join(sessionRoot, executableName));
    project.setValue("CLI", mode === "compile" ? "NO" : "NO");
    project.setValue("media root path", ensureTrailingSlash(path.dirname(sourcePath)));
    await project.save(projectFilePath);

    return {
      workingDirectory: sessionRoot,
      projectFilePath,
      outputExePath: path.join(sessionRoot, executableName),
      errorReportPath: path.join(toolchain.installRoot, "Temp", "ErrorReport.txt"),
      lineMap: [
        {
          sourcePath,
          startLine: 1,
          endLine: countLines(sourceText)
        }
      ],
      primarySourcePath: sourcePath
    };
  }

  private async runCompiler(toolchain: DarkBasicToolchain, session: BuildSession): Promise<boolean> {
    await deleteIfExists(session.outputExePath);
    await deleteIfExists(session.errorReportPath);

    const relativeProjectPath = path.relative(session.workingDirectory, session.projectFilePath);
    this.output.appendLine(`compiler> ${toolchain.compilerExe} ${relativeProjectPath}`);

    const exitCode = await new Promise<number>((resolve, reject) => {
      const compiler = spawn(toolchain.compilerExe, [relativeProjectPath], {
        cwd: session.workingDirectory,
        env: {
          ...process.env,
          DBNEXT_ROOT: toolchain.installRoot
        },
        windowsHide: true
      });

      compiler.stdout.on("data", chunk => {
        this.output.append(chunk.toString());
      });

      compiler.stderr.on("data", chunk => {
        this.output.append(chunk.toString());
      });

      compiler.on("error", reject);
      compiler.on("close", code => resolve(code ?? -1));
    });

    await waitForFile(session.outputExePath, 2000);
    if (await pathExists(session.outputExePath)) {
      return true;
    }

    const errorReport = await readTextIfExists(session.errorReportPath);
    const message = errorReport?.trim() || `DBPCompiler exited with code ${exitCode}, but no executable was produced.`;
    this.output.appendLine(message);
    this.applyDiagnostics(session, message);
    vscode.window.showErrorMessage(message);
    return false;
  }

  private applyDiagnostics(session: BuildSession, errorReport: string): void {
    const lineMatch = errorReport.match(/line\s+(\d+)/i);
    if (!lineMatch) {
      this.diagnostics.set(vscode.Uri.file(session.primarySourcePath), [
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          errorReport,
          vscode.DiagnosticSeverity.Error
        )
      ]);
      return;
    }

    const generatedLine = Number.parseInt(lineMatch[1], 10);
    const mapped = session.lineMap.find(entry => generatedLine >= entry.startLine && generatedLine <= entry.endLine);
    const targetPath = mapped?.sourcePath ?? session.primarySourcePath;
    const targetLine = mapped ? generatedLine - mapped.startLine : Math.max(generatedLine - 1, 0);

    this.diagnostics.set(vscode.Uri.file(targetPath), [
      new vscode.Diagnostic(
        new vscode.Range(targetLine, 0, targetLine, 120),
        errorReport,
        vscode.DiagnosticSeverity.Error
      )
    ]);
  }

  private async launchExecutable(executablePath: string): Promise<void> {
    if (!(await pathExists(executablePath))) {
      vscode.window.showErrorMessage(`Built executable was not found: ${executablePath}`);
      return;
    }

    spawn(executablePath, [], {
      cwd: path.dirname(executablePath),
      detached: true,
      stdio: "ignore",
      windowsHide: false
    }).unref();

    this.output.appendLine(`run> ${executablePath}`);
  }
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
}

function countLines(value: string): number {
  if (value.length === 0) {
    return 1;
  }

  return value.split(/\r\n/).length;
}

function formatTimestamp(value: Date): string {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  const hour = `${value.getHours()}`.padStart(2, "0");
  const minute = `${value.getMinutes()}`.padStart(2, "0");
  const second = `${value.getSeconds()}`.padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(candidate: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(candidate)) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function deleteIfExists(candidate: string): Promise<void> {
  if (await pathExists(candidate)) {
    await fs.rm(candidate, { force: true });
  }
}

async function readTextIfExists(candidate: string): Promise<string | undefined> {
  if (!(await pathExists(candidate))) {
    return undefined;
  }

  return await fs.readFile(candidate, "utf8");
}
