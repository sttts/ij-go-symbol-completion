// Mock extension module for testing
const vscode = require('vscode');

// Define mock objects
const logger = {
    debug: (...args) => console.log('[DEBUG]', ...args),
    info: (...args) => console.log('[INFO]', ...args),
    warn: (...args) => console.log('[WARN]', ...args),
    error: (...args) => console.log('[ERROR]', ...args),
    onDidChangeConfiguration: () => ({ dispose: () => {} })
};

// These functions and objects are picked up by the tests
module.exports = {
    logger,
    mockGoVersion: '1.21.0'
}; 