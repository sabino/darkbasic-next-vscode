import * as fs from "node:fs/promises";
import * as path from "node:path";

interface PairLine {
  readonly type: "pair";
  readonly key: string;
  readonly value: string;
}

interface RawLine {
  readonly type: "raw";
  readonly text: string;
}

type ProjectLine = PairLine | RawLine;

export interface SourceEntry {
  readonly kind: "main" | "include";
  readonly key: string;
  readonly relativePath: string;
  readonly lineKey?: string;
  readonly lineNumber?: number;
}

export class DbProProject {
  private readonly lines: ProjectLine[];

  private constructor(
    public readonly filePath: string,
    lines: ProjectLine[]
  ) {
    this.lines = lines;
  }

  public static async load(filePath: string): Promise<DbProProject> {
    const text = await fs.readFile(filePath, "utf8");
    return DbProProject.parse(filePath, text);
  }

  public static parse(filePath: string, text: string): DbProProject {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n").map<ProjectLine>(line => {
      if (!line.trimStart().startsWith(";")) {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex > 0) {
          return {
            type: "pair",
            key: line.slice(0, separatorIndex).trim(),
            value: line.slice(separatorIndex + 1)
          };
        }
      }

      return {
        type: "raw",
        text: line
      };
    });

    return new DbProProject(filePath, lines);
  }

  public static createTemplate(filePath: string, projectName: string, mainFileName: string): DbProProject {
    const lines = [
      "; **** Dark BASIC Professional Project File ****",
      "; **** Written by DarkBASIC Next ****",
      "version=DBP1.00",
      `project name=${projectName}`,
      "",
      "; **** source file information ****",
      `main=${mainFileName}`,
      "LineMain=1",
      `final source=${mainFileName}`,
      "",
      "; **** Executable Information  ***",
      "; build types: exe, media, installer, alone",
      "executable=Application.exe",
      "build type=exe",
      "; ** Media file compression **",
      "compression=NO",
      "",
      "; ** Media file encryption **",
      "encryption=NO",
      "; ** Display the card options screen window? **",
      "card options window=NO",
      "",
      "; **** debugger information ****",
      "; If the editor sets this to yes, it is running in debug mode",
      "CLI=NO",
      "CommandLineArguments=",
      "",
      "; **** display mode information ****",
      `app title=${projectName}`,
      "",
      "; graphics mode options: fullscreen, window, desktop, fulldesktop, hidden",
      "graphics mode=window",
      "fullscreen resolution=640x480x32",
      "",
      "; arbitrary sizes are valid for windowed mode",
      "window resolution=640x480",
      "",
      "; **** External Files Information ****",
      "",
      "; **** Media ****",
      "; Example entries: media1=graphics\\*.jpg",
      "media root path=",
      "",
      "; **** Icons ****",
      "",
      "; **** Cursors ****",
      "",
      "; **** Version Info ****",
      "VerComments=",
      "VerCompany=",
      "VerFileDesc=",
      "VerFileNumber=",
      "VerInternal=",
      "VerCopyright=",
      "VerTrademark=",
      "VerFilename=",
      "VerProduct=",
      "VerProductNumber=v1.0",
      "",
      "; **** To Do ****",
      "",
      "; **** Comments ****",
      "comments1=",
      "",
      "; **** Advanced (setup.ini) configuration ****",
      "RemoveSafetyCode=NO",
      "SafeArrays=YES",
      "LocalTempFolder=NO",
      "ExternaliseDLLS=NO"
    ];

    return DbProProject.parse(filePath, lines.join("\r\n"));
  }

  public get directory(): string {
    return path.dirname(this.filePath);
  }

  public getProjectName(): string {
    return this.getValue("project name") ?? path.basename(this.filePath, path.extname(this.filePath));
  }

  public getExecutable(): string {
    return this.getValue("executable") ?? "Application.exe";
  }

  public getValue(key: string): string | undefined {
    const match = this.lines.find(line => line.type === "pair" && equalsIgnoreCase(line.key, key));
    return match && match.type === "pair" ? match.value : undefined;
  }

  public setValue(key: string, value: string): void {
    const index = this.lines.findIndex(line => line.type === "pair" && equalsIgnoreCase(line.key, key));
    const pair: PairLine = {
      type: "pair",
      key,
      value
    };

    if (index >= 0) {
      this.lines.splice(index, 1, pair);
      return;
    }

    this.lines.push(pair);
  }

  public getSourceEntries(): SourceEntry[] {
    const entries: SourceEntry[] = [];
    const main = this.getValue("main");
    if (main) {
      const lineValue = this.getValue("LineMain");
      entries.push({
        kind: "main",
        key: "main",
        relativePath: main,
        lineKey: "LineMain",
        lineNumber: parseLineNumber(lineValue)
      });
    }

    const includePairs = this.lines
      .filter((line): line is PairLine => line.type === "pair" && /^include\d+$/i.test(line.key))
      .sort((left, right) => extractNumericSuffix(left.key) - extractNumericSuffix(right.key));

    for (const pair of includePairs) {
      const numericSuffix = extractNumericSuffix(pair.key);
      entries.push({
        kind: "include",
        key: pair.key,
        relativePath: pair.value,
        lineKey: `LineInclude${numericSuffix}`,
        lineNumber: parseLineNumber(this.getValue(`LineInclude${numericSuffix}`))
      });
    }

    return entries;
  }

  public getAbsoluteSourcePaths(): string[] {
    return this.getSourceEntries().map(entry => path.resolve(this.directory, entry.relativePath));
  }

  public containsSource(filePath: string): boolean {
    const normalizedTarget = path.normalize(filePath).toLowerCase();
    return this.getAbsoluteSourcePaths().some(sourcePath => path.normalize(sourcePath).toLowerCase() === normalizedTarget);
  }

  public setSources(mainRelativePath: string, includeRelativePaths: readonly string[]): void {
    const newSourceLines: ProjectLine[] = [
      { type: "pair", key: "main", value: mainRelativePath },
      { type: "pair", key: "LineMain", value: "1" }
    ];

    includeRelativePaths.forEach((includePath, index) => {
      const suffix = index + 1;
      newSourceLines.push({
        type: "pair",
        key: `include${suffix}`,
        value: includePath
      });
      newSourceLines.push({
        type: "pair",
        key: `LineInclude${suffix}`,
        value: "1"
      });
    });

    newSourceLines.push({
      type: "pair",
      key: "final source",
      value: "_Temp.dbsource"
    });
    newSourceLines.push({
      type: "raw",
      text: ""
    });

    const sectionStart = this.lines.findIndex(line =>
      line.type === "raw" && /source file information/i.test(line.text)
    );
    const nextSection = this.lines.findIndex((line, index) =>
      index > sectionStart &&
      line.type === "raw" &&
      /^;\s+\*{4}/.test(line.text)
    );

    if (sectionStart >= 0) {
      const replaceEnd = nextSection >= 0 ? nextSection : this.lines.length;
      this.lines.splice(sectionStart + 1, replaceEnd - (sectionStart + 1), ...newSourceLines);
      return;
    }

    this.lines.push(
      { type: "raw", text: "; **** source file information ****" },
      ...newSourceLines
    );
  }

  public cloneTo(filePath: string): DbProProject {
    return DbProProject.parse(filePath, this.toString());
  }

  public async save(filePath = this.filePath): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, this.toString(), "utf8");
  }

  public toString(): string {
    const serialized = this.lines.map(line => {
      if (line.type === "pair") {
        return `${line.key}=${line.value}`;
      }

      return line.text;
    });

    return `${serialized.join("\r\n")}\r\n`;
  }
}

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function extractNumericSuffix(value: string): number {
  const match = value.match(/(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function parseLineNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
