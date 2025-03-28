# Go Symbol Completion

A VS Code extension that provides IntelliJ-like symbol completion for Go code, with or without package prefixes.

## Features

- Provides code completion for Go symbols across all packages in your workspace and dependencies
- Works with or without package prefixes (e.g., both `kubernetes.NewForConfig` and just `NewForConfig` will show completions)
- Adds the necessary imports automatically when a suggestion is accepted
- Shows detailed signature information for functions
- Intelligent function parameter snippets

## Requirements

- Go (at least version 1.12) must be installed
- The `gopls` language server must be installed (`go install golang.org/x/tools/gopls@latest`)

## How It Works

This extension builds a cache of Go symbols by scanning all packages in your workspace and dependencies. It uses the `gopls` tool to fetch symbol information.

When you start typing a symbol name, the extension looks up matching symbols from the cache and provides them as completion suggestions. If you type a package prefix followed by a dot (e.g., `kubernetes.`), it filters the results to show only symbols from matching packages.

## Extension Settings

This extension contributes the following settings:

* `goSymbolCompletion.enabled`: Enable/disable Go symbol completion
* `goSymbolCompletion.goplsPath`: Path to the gopls executable

## Known Issues

- The initial symbol cache building can take some time for large workspaces with many dependencies
- The extension may not find symbols in packages that have not been downloaded yet

## Release Notes

### 0.0.1

Initial release with basic functionality.

## Development

### Building the Extension

1. Clone the repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to compile the TypeScript
4. Press F5 to launch a new VS Code window with the extension loaded

### Running Tests

Run `npm test` to execute the tests. 