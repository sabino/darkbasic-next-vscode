import * as path from "node:path";
import * as vscode from "vscode";
import { HelpEntry, HelpIndex } from "../services/helpIndex";
import { resolveToolchain } from "../services/toolchain";

export function registerDarkBasicLanguageProviders(
  context: vscode.ExtensionContext,
  helpIndex: HelpIndex
): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: "darkbasic", scheme: "file" },
      new DarkBasicCompletionItemProvider(helpIndex)
    ),
    vscode.languages.registerHoverProvider(
      { language: "darkbasic", scheme: "file" },
      new DarkBasicHoverProvider(helpIndex)
    ),
    vscode.languages.registerDocumentSymbolProvider(
      { language: "darkbasic", scheme: "file" },
      new DarkBasicDocumentSymbolProvider()
    ),
    vscode.languages.registerDefinitionProvider(
      { language: "darkbasic", scheme: "file" },
      new DarkBasicDefinitionProvider()
    )
  );
}

export async function resolveHelpEntryFromEditor(
  helpIndex: HelpIndex,
  editor: vscode.TextEditor | undefined
): Promise<HelpEntry | undefined> {
  if (!editor) {
    return undefined;
  }

  const toolchain = await resolveToolchain();
  if (!toolchain) {
    return undefined;
  }

  const match = await helpIndex.findBestMatchAtPosition(toolchain, editor.document, editor.selection.active);
  if (match) {
    return match.entry;
  }

  const selectionText = editor.document.getText(editor.selection).trim();
  if (selectionText) {
    return await helpIndex.findExact(toolchain, selectionText);
  }

  const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active, /[#$A-Za-z0-9_]+/);
  const word = wordRange ? editor.document.getText(wordRange) : "";
  return word ? await helpIndex.findExact(toolchain, word) : undefined;
}

class DarkBasicCompletionItemProvider implements vscode.CompletionItemProvider {
  public constructor(private readonly helpIndex: HelpIndex) {}

  public async provideCompletionItems(): Promise<vscode.CompletionItem[]> {
    const toolchain = await resolveToolchain();
    if (!toolchain) {
      return [];
    }

    const entries = await this.helpIndex.getEntries(toolchain);
    return entries.map(entry => {
      const item = new vscode.CompletionItem(entry.command, vscode.CompletionItemKind.Function);
      item.insertText = entry.command;
      item.detail = entry.signature ? `${entry.command} ${entry.signature}` : entry.command;
      item.sortText = entry.command;
      item.filterText = entry.command;
      item.documentation = new vscode.MarkdownString(
        entry.signature
          ? `\`${entry.command} ${entry.signature}\`\n\n${entry.category}`
          : `\`${entry.command}\`\n\n${entry.category}`
      );
      return item;
    });
  }
}

class DarkBasicHoverProvider implements vscode.HoverProvider {
  public constructor(private readonly helpIndex: HelpIndex) {}

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const toolchain = await resolveToolchain();
    if (!toolchain) {
      return undefined;
    }

    const match = await this.helpIndex.findBestMatchAtPosition(toolchain, document, position);
    if (!match) {
      return undefined;
    }

    const summary = await this.helpIndex.getSummary(match.entry);
    const markdown = new vscode.MarkdownString();
    markdown.appendCodeblock(
      match.entry.signature ? `${match.entry.command} ${match.entry.signature}` : match.entry.command,
      "darkbasic"
    );

    if (summary) {
      markdown.appendMarkdown(`\n\n${summary}`);
    }

    markdown.appendMarkdown(`\n\nSource: \`${match.entry.sourceFile}\``);
    return new vscode.Hover(markdown, match.range);
  }
}

class DarkBasicDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  public provideDocumentSymbols(document: vscode.TextDocument): vscode.SymbolInformation[] {
    const symbols: vscode.SymbolInformation[] = [];

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex += 1) {
      const lineText = document.lineAt(lineIndex).text;
      const trimmed = lineText.trim();
      if (trimmed.length === 0 || trimmed.startsWith("`") || /^rem\b/i.test(trimmed)) {
        continue;
      }

      const functionMatch = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_$]*)/i);
      if (functionMatch) {
        symbols.push(
          new vscode.SymbolInformation(
            functionMatch[1],
            vscode.SymbolKind.Function,
            "",
            new vscode.Location(document.uri, new vscode.Position(lineIndex, lineText.indexOf(functionMatch[1])))
          )
        );
        continue;
      }

      const typeMatch = trimmed.match(/^type\s+([A-Za-z_][A-Za-z0-9_$]*)/i);
      if (typeMatch) {
        symbols.push(
          new vscode.SymbolInformation(
            typeMatch[1],
            vscode.SymbolKind.Class,
            "",
            new vscode.Location(document.uri, new vscode.Position(lineIndex, lineText.indexOf(typeMatch[1])))
          )
        );
        continue;
      }

      const labelMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_$]*)\s*:/);
      if (labelMatch) {
        symbols.push(
          new vscode.SymbolInformation(
            labelMatch[1],
            vscode.SymbolKind.Key,
            "",
            new vscode.Location(document.uri, new vscode.Position(lineIndex, lineText.indexOf(labelMatch[1])))
          )
        );
      }
    }

    return symbols;
  }
}

class DarkBasicDefinitionProvider implements vscode.DefinitionProvider {
  public provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Location | undefined {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_$]*/);
    if (!wordRange) {
      return undefined;
    }

    const word = document.getText(wordRange);
    const definitionPatterns = [
      new RegExp(`^\\s*function\\s+${escapeRegex(word)}\\b`, "i"),
      new RegExp(`^\\s*type\\s+${escapeRegex(word)}\\b`, "i"),
      new RegExp(`^\\s*${escapeRegex(word)}\\s*:`, "i")
    ];

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex += 1) {
      const lineText = document.lineAt(lineIndex).text;
      if (definitionPatterns.some(pattern => pattern.test(lineText))) {
        const matchIndex = lineText.toUpperCase().indexOf(word.toUpperCase());
        return new vscode.Location(
          document.uri,
          new vscode.Position(lineIndex, Math.max(matchIndex, 0))
        );
      }
    }

    return undefined;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
