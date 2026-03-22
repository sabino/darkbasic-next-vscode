import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { DarkBasicToolchain } from "./toolchain";

export interface HelpEntry {
  readonly command: string;
  readonly normalizedCommand: string;
  readonly signature: string;
  readonly helpRelativePath: string;
  readonly helpAbsolutePath: string;
  readonly category: string;
  readonly sourceFile: string;
}

export interface HelpMatch {
  readonly entry: HelpEntry;
  readonly range: vscode.Range;
}

export class HelpIndex {
  private cachedInstallRoot: string | undefined;
  private entries: HelpEntry[] = [];
  private commandMap = new Map<string, HelpEntry[]>();
  private summaryCache = new Map<string, string>();

  public constructor(private readonly output: vscode.OutputChannel) {}

  public async getEntries(toolchain: DarkBasicToolchain): Promise<readonly HelpEntry[]> {
    await this.ensureLoaded(toolchain);
    return this.entries;
  }

  public async findExact(toolchain: DarkBasicToolchain, command: string): Promise<HelpEntry | undefined> {
    await this.ensureLoaded(toolchain);
    const normalized = normalizeCommand(command);
    return this.commandMap.get(normalized)?.[0];
  }

  public async search(toolchain: DarkBasicToolchain, term: string): Promise<readonly HelpEntry[]> {
    await this.ensureLoaded(toolchain);
    const normalized = normalizeCommand(term);
    if (!normalized) {
      return this.entries;
    }

    return this.entries.filter(entry => entry.normalizedCommand.includes(normalized));
  }

  public async findBestMatchAtPosition(
    toolchain: DarkBasicToolchain,
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<HelpMatch | undefined> {
    await this.ensureLoaded(toolchain);

    const lineText = document.lineAt(position.line).text;
    const tokens = Array.from(lineText.matchAll(/[#$A-Za-z0-9_]+/g));
    if (tokens.length === 0) {
      return undefined;
    }

    const tokenIndex = tokens.findIndex(match => {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      return position.character >= start && position.character <= end;
    });

    if (tokenIndex < 0) {
      return undefined;
    }

    let bestMatch: HelpMatch | undefined;
    for (let startIndex = Math.max(0, tokenIndex - 4); startIndex <= tokenIndex; startIndex += 1) {
      for (let endIndex = tokenIndex; endIndex < Math.min(tokens.length, startIndex + 5); endIndex += 1) {
        if (tokenIndex < startIndex || tokenIndex > endIndex) {
          continue;
        }

        const startToken = tokens[startIndex];
        const endToken = tokens[endIndex];
        const start = startToken.index ?? 0;
        const end = (endToken.index ?? 0) + endToken[0].length;
        const candidateText = lineText.slice(start, end);
        const entry = this.commandMap.get(normalizeCommand(candidateText))?.[0];
        if (!entry) {
          continue;
        }

        const candidateRange = new vscode.Range(position.line, start, position.line, end);
        if (!bestMatch || entry.command.length > bestMatch.entry.command.length) {
          bestMatch = {
            entry,
            range: candidateRange
          };
        }
      }
    }

    return bestMatch;
  }

  public async getSummary(entry: HelpEntry): Promise<string | undefined> {
    const cached = this.summaryCache.get(entry.helpAbsolutePath);
    if (cached) {
      return cached;
    }

    if (!(await pathExists(entry.helpAbsolutePath))) {
      return undefined;
    }

    const text = await fs.readFile(entry.helpAbsolutePath, "utf8");
    const paragraphMatch = text.match(/<p>\s*([\s\S]*?)\s*<\/p>/i);
    if (!paragraphMatch) {
      return undefined;
    }

    const summary = decodeHtml(stripHtml(paragraphMatch[1])).replace(/\s+/g, " ").trim();
    if (summary.length > 0) {
      this.summaryCache.set(entry.helpAbsolutePath, summary);
      return summary;
    }

    return undefined;
  }

  private async ensureLoaded(toolchain: DarkBasicToolchain): Promise<void> {
    if (this.cachedInstallRoot === toolchain.installRoot && this.entries.length > 0) {
      return;
    }

    const keywordRoot = path.join(toolchain.installRoot, "Editor", "Keywords");
    const files = await fs.readdir(keywordRoot);
    const entries: HelpEntry[] = [];
    const dedupe = new Set<string>();

    for (const file of files.filter(fileName => fileName.toLowerCase().endsWith(".ini")).sort()) {
      const fullPath = path.join(keywordRoot, file);
      const text = await fs.readFile(fullPath, "utf8");
      const lines = text.split(/\r?\n/);

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith(";") || line.startsWith("[")) {
          continue;
        }

        const firstSeparator = line.indexOf("=");
        const secondSeparator = firstSeparator >= 0 ? line.indexOf("=", firstSeparator + 1) : -1;
        if (firstSeparator <= 0 || secondSeparator <= firstSeparator) {
          continue;
        }

        const command = line.slice(0, firstSeparator).trim();
        const helpRelativePath = line.slice(firstSeparator + 1, secondSeparator).trim();
        const signature = line.slice(secondSeparator + 1).trim();
        const normalizedCommand = normalizeCommand(command);
        const helpAbsolutePath = path.join(toolchain.helpRoot, helpRelativePath.replace(/\\/g, path.sep));
        const dedupeKey = `${normalizedCommand}|${helpRelativePath.toLowerCase()}`;
        if (!normalizedCommand || dedupe.has(dedupeKey)) {
          continue;
        }

        dedupe.add(dedupeKey);
        entries.push({
          command,
          normalizedCommand,
          signature,
          helpRelativePath,
          helpAbsolutePath,
          category: file.replace(/\.ini$/i, ""),
          sourceFile: file
        });
      }
    }

    this.entries = entries.sort((left, right) => left.command.localeCompare(right.command));
    this.commandMap = new Map<string, HelpEntry[]>();
    for (const entry of this.entries) {
      const bucket = this.commandMap.get(entry.normalizedCommand);
      if (bucket) {
        bucket.push(entry);
      } else {
        this.commandMap.set(entry.normalizedCommand, [entry]);
      }
    }

    this.summaryCache.clear();
    this.cachedInstallRoot = toolchain.installRoot;
    this.output.appendLine(`Loaded ${this.entries.length} DarkBASIC help entries from ${keywordRoot}`);
  }
}

export function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, " ").trim().toUpperCase();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
