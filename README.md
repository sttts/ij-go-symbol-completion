# Go Symbol Completion for VS Code

[![Tests](https://github.com/sttts/ij-go-symbol-completion/actions/workflows/tests.yml/badge.svg)](https://github.com/sttts/ij-go-symbol-completion/actions/workflows/tests.yml)
[![Release](https://img.shields.io/github/v/release/sttts/ij-go-symbol-completion)](https://github.com/sttts/ij-go-symbol-completion/releases/latest)

> ⚠️ **EXPERIMENTAL**: This extension is an experiment in using [Cursor](https://cursor.sh) exclusively for development. **100% of the code was written without human modification** - all coding, debugging, and optimization was done through Cursor's AI interfaces, without direct human editing of the codebase. This serves as a demonstration of what's possible with modern AI-assisted development tools.

A VS Code extension that provides symbol completion for Go code with or without package prefixes (similar to other popular IDEs), drastically improving the Go development experience in VS Code.

![Go Symbol Completion in action](contrib/screencast.gif)

> 🚀 **For Go developers tired of subpar symbol completion**
>
> This extension solves one of the biggest frustrations in VS Code Go development: the inability to autocomplete symbols without typing the full package prefix.

## Motivation

This extension was born out of a common frustration among Go developers transitioning from other popular IDEs to VS Code:

![Twitter motivation](contrib/tweet.png)

The built-in Go extension for VS Code requires you to type the full package name before offering completions. With this extension, you can type just the symbol name (like in other popular IDEs) and get full completions with automatic imports.

## Features

- **Smart IDE-style completions**: Type any symbol name without package prefix to get completions
- **Package prefixed completions**: Also supports traditional `package.Symbol` style completions
- **Automatic imports**: Automatically adds imports when you select a completion
- **Background indexing**: Indexes workspace and dependency packages for fast completions
- **Workspace-specific caching**: Maintains a local cache for optimal performance
- **Package reindexing**: Right-click on an import to reindex a package when it's updated

## Installation

1. Download the `.vsix` file from the [releases page](https://github.com/yourusername/ij-go-symbol-completion/releases)
2. In VS Code, go to Extensions (Ctrl+Shift+X)
3. Click "..." in the top-right and select "Install from VSIX..."
4. Choose the downloaded file

## How to Use

Just start typing the name of any Go symbol - the extension will suggest completions from all indexed packages:

```go
// Instead of typing:
kubernetes.NewForConfig(...)

// You can just type:
NewForC█   // Shows "NewForConfig" suggestion with automatic import
```

Right-click on any import statement to reindex a package if you've updated it.

## Commands

- **Go: Reindex Package** - Reindex a specific package and its subpackages
- **Go: Show Symbol Cache** - View debug information about the symbol cache
- **Go: Show Package Debug Info** - Get detailed info about a specific package

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `goSymbolCompletion.enabled` | Enable/disable the extension | `true` |
| `goSymbolCompletion.debugLevel` | Log verbosity (0-3) | `1` |
| `goSymbolCompletion.limitToDirectDeps` | Only index direct dependencies | `true` |

## Requirements

- Go 1.12+ must be installed and in your PATH
- VS Code 1.60.0 or newer

## Known Issues

- Initial indexing may take time for large codebases
- Some edge cases in workspace-specific packages might need manual reindexing

## Contributing

Contributions are welcome! Feel free to submit issues and pull requests.

## License

This project is licensed under the MIT License - see the LICENSE file for details. 