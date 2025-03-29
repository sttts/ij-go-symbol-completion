// Mock vscode module for tests
module.exports = {
    workspace: {
        getConfiguration: () => ({
            get: () => true
        }),
        workspaceFolders: []
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => {},
            clear: () => {},
            show: () => {}
        })
    },
    commands: {
        registerCommand: () => {}
    }
}; 