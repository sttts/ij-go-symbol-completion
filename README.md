# Go Symbol Completion for VS Code

A VS Code extension that provides IntelliJ-like symbol completion for Go code with or without package prefixes, drastically improving the Go development experience in VS Code.

![Go Symbol Completion in action](https://i.imgur.com/YOUR_SCREENSHOT_URL.png)

> 🚀 **For Go developers tired of subpar symbol completion**
>
> This extension solves one of the biggest frustrations in VS Code Go development: the inability to autocomplete symbols without typing the full package prefix.

## Motivation

This extension was born out of a common frustration among Go developers transitioning from JetBrains products to VS Code:

![Twitter motivation](https://pbs.twimg.com/media/GOiwDnfWwAArXKB?format=jpg&name=medium)

*Note: Please replace this with an actual screenshot of the tweet at https://x.com/the_sttts/status/1905285885244883163*

The built-in Go extension for VS Code requires you to type the full package name before offering completions. With this extension, you can type just the symbol name (like in IntelliJ/GoLand) and get full completions with automatic imports.

## Features

- **IntelliJ-style completions**: Type any symbol name without package prefix to get completions
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

## Built with Cursor

This extension is itself an experiment in using [Cursor](https://cursor.sh) for Golang development. The entire extension was developed exclusively in Cursor to demonstrate how AI-powered tools can enhance the development workflow.

## AI-Generated Code

What makes this project unique is that **100% of the code was written without human modification**. All coding, debugging, and optimization was done through AI interfaces in Cursor, without direct human editing of the codebase. This serves as a demonstration of what's possible with modern AI-assisted development tools.

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