// Mock vscode module for tests
module.exports = {
    workspace: {
        getConfiguration: () => ({
            get: () => true
        }),
        workspaceFolders: [],
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
        }
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