import * as vscode from "vscode";
import { DarkBasicToolchain } from "./toolchain";
import { runProcess } from "./processUtils";

export interface PackageManifest {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly summary: string;
  readonly kind: string;
  readonly homepage: string;
  readonly license: string;
  readonly sourceUrl: string;
  readonly licenseStatus: string;
  readonly mirrorPolicy: string;
  readonly artifactUrl: string;
  readonly sha256: string;
  readonly dependencies: readonly string[];
  readonly manualInstructions: string;
}

export interface ResolvedPackage {
  readonly manifest: PackageManifest;
  readonly source: {
    readonly name: string;
    readonly indexUrl: string;
  };
}

export interface InstalledPackageRecord {
  readonly id: string;
  readonly version: string;
  readonly sourceName: string;
  readonly installedAtUtc: string;
  readonly files: readonly string[];
}

export interface DoctorReport {
  readonly installRoot: string;
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly passed: boolean;
    readonly message: string;
  }>;
}

export class DbNextClient {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public async search(toolchain: DarkBasicToolchain, term: string): Promise<ResolvedPackage[]> {
    return await this.runJson<ResolvedPackage[]>(toolchain, ["search", term, "--json"]);
  }

  public async listInstalled(toolchain: DarkBasicToolchain): Promise<InstalledPackageRecord[]> {
    return await this.runJson<InstalledPackageRecord[]>(toolchain, ["list", "--json"]);
  }

  public async install(toolchain: DarkBasicToolchain, packageId: string): Promise<string> {
    return await this.runText(toolchain, ["install", packageId]);
  }

  public async update(toolchain: DarkBasicToolchain, packageId?: string): Promise<string> {
    const args = packageId ? ["update", packageId] : ["update"];
    return await this.runText(toolchain, args);
  }

  public async doctor(toolchain: DarkBasicToolchain): Promise<DoctorReport> {
    return await this.runJson<DoctorReport>(toolchain, ["doctor", "--json"]);
  }

  private async runJson<T>(toolchain: DarkBasicToolchain, args: string[]): Promise<T> {
    const raw = await this.runText(toolchain, args);
    return JSON.parse(raw) as T;
  }

  private async runText(toolchain: DarkBasicToolchain, args: string[]): Promise<string> {
    if (!toolchain.dbnextExe) {
      throw new Error("dbnext.exe was not found. Set darkbasicNext.dbnextPath or install the DarkBASIC Next tools.");
    }

    this.output.appendLine(`dbnext> ${args.join(" ")}`);
    const result = await runProcess(toolchain.dbnextExe, args, {
      cwd: toolchain.installRoot,
      env: {
        ...process.env,
        DBNEXT_ROOT: toolchain.installRoot
      }
    });

    if (result.stdout.trim().length > 0) {
      this.output.appendLine(result.stdout.trimEnd());
    }

    if (result.stderr.trim().length > 0) {
      this.output.appendLine(result.stderr.trimEnd());
    }

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `dbnext exited with code ${result.exitCode}.`);
    }

    return result.stdout.trim();
  }
}
