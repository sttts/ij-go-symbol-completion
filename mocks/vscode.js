// Mock vscode module for tests
module.exports = {
    workspace: {
        getConfiguration: () => ({
            get: () => true
        }),
        workspaceFolders: [
            {
                uri: {
                    fsPath: process.cwd(),
                    path: process.cwd()
                },
                name: 'ij-go-symbol-completion',
                index: 0
            }
        ],
        // Add event handlers
        onDidChangeConfiguration: (callback) => {
            // Return a disposable object
            return { dispose: () => {} };
        },
        onDidChangeWorkspaceFolders: (callback) => {
            return { dispose: () => {} };
        },
        onDidChangeTextDocument: (callback) => {
            return { dispose: () => {} };
        },
        createFileSystemWatcher: () => ({
            onDidChange: () => ({ dispose: () => {} }),
            onDidCreate: () => ({ dispose: () => {} }),
            onDidDelete: () => ({ dispose: () => {} }),
            dispose: () => {}
        })
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => {},
            clear: () => {},
            show: () => {},
            dispose: () => {}
        }),
        showInformationMessage: () => Promise.resolve(),
        showErrorMessage: () => Promise.resolve()
    },
    commands: {
        registerCommand: () => ({ dispose: () => {} }),
        executeCommand: () => Promise.resolve()
    },
    extensions: {
        getExtension: (id) => {
            if (id === 'sttts.ij-go-symbol-completion') {
                return {
                    packageJSON: {
                        version: '0.1.0'
                    }
                };
            }
            return null;
        }
    },
    // Add other commonly used APIs
    EventEmitter: class {
        constructor() {}
        event = () => ({ dispose: () => {} });
        fire() {}
        dispose() {}
    },
    Disposable: class {
        static from(...disposables) {
            return { dispose: () => {} };
        }
        dispose() {}
    },
    Uri: {
        file: (path) => ({ fsPath: path, path: path }),
        parse: (uri) => ({ fsPath: uri, path: uri })
    }
}; 