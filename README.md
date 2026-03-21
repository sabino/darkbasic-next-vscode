# DarkBASIC Next

DarkBASIC Next is a VS Code extension for DarkBASIC Professional and the
modernized DarkBASIC Next toolchain.

## Current scope

- `.dba`, `.dbsource`, and `.dbpro` awareness
- syntax highlighting and starter snippets
- project open/create/save flows for `.dbpro`
- project tree for source files
- compile and compile-and-run against `DBPCompiler.exe`
- package search, install, update, and doctor via `dbnext.exe`
- local help entry point for repo-local or installed help content

## Toolchain discovery

The extension resolves the toolchain in this order:

1. `darkbasicNext.installRoot`
2. `DBNEXT_ROOT`
3. an ancestor `Install` directory in the current workspace
4. a few legacy Windows install locations

When `darkbasicNext.dbnextPath` is empty, package commands use
`Install\Tools\dbnext.exe`.

## Supported workflows

- Open a `.dbpro` project with `DarkBASIC Next: Open Project`
- Create a new project with `DarkBASIC Next: New Project`
- Compile the current project or active loose `.dba` file
- Run the last successful build with `DarkBASIC Next: Run Previous Build`
- Search/install packages with `DarkBASIC Next: Search Packages`
- Open local help with `DarkBASIC Next: Open Help`

Loose `.dba` files are built through a synthesized temporary `.dbpro` so the
compiler path stays consistent with project builds.

## Current gaps

- The legacy Synergy debugger protocol is not bridged to VS Code yet.
- Media, cursors, TODO, and properties are preserved in `.dbpro` files but do
  not have dedicated editors yet.
- The extension focuses on Windows build/run/package flows; editing works
  elsewhere, but compile/run commands require a Windows DarkBASIC toolchain.

## Development

```powershell
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.
