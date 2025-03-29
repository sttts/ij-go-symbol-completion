import * as vscode from 'vscode';
import * as cp from 'child_process';
import { GoSymbolCompletionProvider } from './goSymbolCompletionProvider';
import { GoSymbolCache } from './goSymbolCache';

export class Logger {
  private outputChannel: vscode.OutputChannel;
  private debugLevel: number = 1; // Default to level 1

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Go Symbol Completion');
    this.updateDebugLevel();
    
    // Listen for configuration changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('goSymbolCompletion.debugLevel')) {
        this.updateDebugLevel();
      }
    });
  }

  private updateDebugLevel(): void {
    const config = vscode.workspace.getConfiguration('goSymbolCompletion');
    this.debugLevel = config.get<number>('debugLevel', 1);
    this.log(`Debug level set to ${this.debugLevel}`, 1);
  }

  public log(message: string, level: number = 1): void {
    // Only log if the message's level is less than or equal to the current debug level
    if (level <= this.debugLevel) {
      const timestamp = new Date().toISOString();
      this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }
  }

  public show(): void {
    this.outputChannel.show();
  }
}

export const logger = new Logger();

// Check if a command exists and is executable
async function checkCommandExists(cmd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // On Unix-like systems, 'which' will check if the command exists
    // On Windows, 'where' will do the same
    const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    
    cp.exec(checkCmd, (error) => {
      resolve(!error);
    });
  });
}

// Check gopls version
async function getGoplsVersion(goplsPath: string): Promise<string> {
  return new Promise<string>((resolve) => {
    cp.exec(`${goplsPath} version`, (error, stdout, stderr) => {
      if (error) {
        resolve(`Error: ${stderr || error.message}`);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// Keep track of the symbol cache instance
let globalSymbolCache: GoSymbolCache | undefined;

export async function activate(context: vscode.ExtensionContext) {
  logger.log('Go Symbol Completion extension activated');
  logger.show(); // Show the output channel for debugging
  
  // More detailed logging
  logger.log(`Extension path: ${context.extensionPath}`);
  logger.log(`VS Code version: ${vscode.version}`);

  try {
    // Check that Go is installed
    const goVersion = await executeCommand('go version');
    logger.log(`Go version: ${goVersion}`);
  } catch (error) {
    logger.log(`Error checking Go version: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // Create a new symbol cache
  const symbolCache = new GoSymbolCache();
  globalSymbolCache = symbolCache;
  
  // Register the completion provider
  const completionProvider = new GoSymbolCompletionProvider(symbolCache);
  
  // Register the completion provider for Go files
  const selector: vscode.DocumentSelector = [
    { language: 'go', scheme: 'file' },
    { language: 'go', scheme: 'untitled' }
  ];
  
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      completionProvider,
      '.' // Trigger character
    )
  );
  
  // Register command to handle command chaining
  context.subscriptions.push(
    vscode.commands.registerCommand('_ij-go-symbol-completion.chainCommands', async (cmdWithNext) => {
      // Execute the next command stored in the 'next' property
      if (cmdWithNext && cmdWithNext.next) {
        // Wait a bit for the current command to complete
        setTimeout(async () => {
          try {
            await vscode.commands.executeCommand(
              cmdWithNext.next.command,
              ...(cmdWithNext.next.arguments || [])
            );
          } catch (error) {
            logger.log(`Error executing chained command: ${error instanceof Error ? error.message : String(error)}`);
          }
        }, 100);
      }
    })
  );
  
  // Register command to show the symbol cache
  context.subscriptions.push(
    vscode.commands.registerCommand('ij-go-symbol-completion.showSymbolCache', () => {
      // Force fresh info by accessing the latest data
      const freshSymbolCache = getOrCreateSymbolCache();
      const cacheContents = freshSymbolCache.getDebugInfo(true); // Pass true to show all symbols
      
      const doc = vscode.workspace.openTextDocument({ 
        content: cacheContents, 
        language: 'markdown' 
      });
      
      doc.then(document => {
        vscode.window.showTextDocument(document);
      });
    })
  );
  
  // Register command to reindex a package
  registerReindexPackageCommand(context);
  
  // Initialize the symbol cache and index built-in packages
  try {
    logger.log('Starting symbol indexing...');
    await symbolCache.initialize();
    logger.log('Symbol indexing completed');
  } catch (error) {
    logger.log(`Error initializing symbol cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Register a command to reindex a Go package from an import statement
 */
function registerReindexPackageCommand(context: vscode.ExtensionContext) {
  // Register a command that can be invoked from the context menu
  context.subscriptions.push(
    vscode.commands.registerCommand('ij-go-symbol-completion.reindexPackage', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('No active editor');
        return;
      }

      const document = editor.document;
      if (document.languageId !== 'go') {
        vscode.window.showInformationMessage('Not a Go file');
        return;
      }

      // Extract package name from the current cursor position
      const position = editor.selection.active;
      const packageName = extractPackageFromImportAtPosition(document, position);

      if (!packageName) {
        // If no package found at cursor, prompt the user to enter one
        const inputPackage = await vscode.window.showInputBox({
          prompt: 'Enter the package path to reindex',
          placeHolder: 'e.g., github.com/user/repo'
        });

        if (!inputPackage) {
          return; // User cancelled
        }

        await reindexPackage(inputPackage);
      } else {
        await reindexPackage(packageName);
      }
    })
  );

  // Add the command to editor context menu
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand('ij-go-symbol-completion.reindexPackageFromContext', async (editor) => {
      if (editor.document.languageId !== 'go') {
        vscode.window.showInformationMessage('Not a Go file');
        return;
      }

      const packageName = extractPackageFromImportAtPosition(editor.document, editor.selection.active);
      if (packageName) {
        await reindexPackage(packageName);
      } else {
        vscode.window.showInformationMessage('No Go package found at cursor position');
      }
    })
  );
}

/**
 * Extract the package name from an import statement at the given position
 */
function extractPackageFromImportAtPosition(document: vscode.TextDocument, position: vscode.Position): string | null {
  // Check if the current line is an import statement
  const line = document.lineAt(position.line).text;
  
  // Check for single-line import: import "package/path"
  const singleImportMatch = line.match(/import\s+(?:"([^"]+)"|([^"\s]+))/);
  if (singleImportMatch) {
    return singleImportMatch[1] || singleImportMatch[2];
  }
  
  // Check for import within a block: import ( "package/path" )
  const importLineMatch = line.match(/\s*(?:"([^"]+)"|([^"\s]+))/);
  if (importLineMatch) {
    // Verify we're in an import block by searching up
    let lineNum = position.line;
    while (lineNum >= 0) {
      const checkLine = document.lineAt(lineNum).text;
      if (checkLine.includes('import (')) {
        return importLineMatch[1] || importLineMatch[2];
      }
      if (checkLine.includes(')')) {
        break; // We've reached the end of a different block
      }
      lineNum--;
    }
  }
  
  // Check for named import: import alias "package/path"
  const namedImportMatch = line.match(/import\s+\w+\s+(?:"([^"]+)"|([^"\s]+))/);
  if (namedImportMatch) {
    return namedImportMatch[1] || namedImportMatch[2];
  }
  
  // Check for named import in block: alias "package/path"
  const namedImportBlockMatch = line.match(/\s*\w+\s+(?:"([^"]+)"|([^"\s]+))/);
  if (namedImportBlockMatch) {
    // Verify we're in an import block by searching up
    let lineNum = position.line;
    while (lineNum >= 0) {
      const checkLine = document.lineAt(lineNum).text;
      if (checkLine.includes('import (')) {
        return namedImportBlockMatch[1] || namedImportBlockMatch[2];
      }
      if (checkLine.includes(')')) {
        break; // We've reached the end of a different block
      }
      lineNum--;
    }
  }
  
  return null;
}

/**
 * Reindex a package and its subpackages
 */
async function reindexPackage(packageName: string): Promise<void> {
  // Show progress indication
  vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Reindexing package: ${packageName}`,
    cancellable: false
  }, async (progress) => {
    try {
      const symbolCache = getOrCreateSymbolCache();
      progress.report({ message: 'Indexing symbols...' });
      await symbolCache.reindexPackage(packageName);
      vscode.window.showInformationMessage(`Package ${packageName} reindexed successfully`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to reindex package: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

// Helper function to get or create the symbol cache
function getOrCreateSymbolCache(): GoSymbolCache {
  if (!globalSymbolCache) {
    globalSymbolCache = new GoSymbolCache();
    globalSymbolCache.initialize().catch(err => {
      logger.log(`Error initializing symbol cache on demand: ${err.message}`);
    });
  }
  return globalSymbolCache;
}

function initializeExtension(context: vscode.ExtensionContext) {
  // Create the symbol cache
  const symbolCache = new GoSymbolCache();
  globalSymbolCache = symbolCache;
  
  // Register the completion provider for Go files
  const completionProvider = new GoSymbolCompletionProvider(symbolCache);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'file', language: 'go' },
      completionProvider,
      '.', // Trigger on dot for package member completion
      // Also trigger on any character for non-package prefixed completions
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
      'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
      'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
      'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
      '_'
    )
  );
  
  // Register a command to show the symbol cache (for debugging/verification)
  context.subscriptions.push(
    vscode.commands.registerCommand('ij-go-symbol-completion.showSymbolCache', () => {
      // Force fresh info by accessing the latest data
      const freshSymbolCache = getOrCreateSymbolCache();
      const cacheContents = freshSymbolCache.getDebugInfo(true); // Pass true to show all symbols
      
      const doc = vscode.workspace.openTextDocument({ 
        content: cacheContents, 
        language: 'markdown' 
      });
      
      doc.then(document => {
        vscode.window.showTextDocument(document);
      });
    })
  );
  
  // Initialize the symbol cache
  symbolCache.initialize().then(() => {
    vscode.window.showInformationMessage('Go Symbol Cache initialized');
    logger.log('Go Symbol Cache initialization completed successfully');
  }).catch((err: Error) => {
    vscode.window.showErrorMessage(`Failed to initialize Go Symbol Cache: ${err.message}`);
    logger.log(`Error initializing Go Symbol Cache: ${err.message}`);
  });
}

export function deactivate() {
  // Clean up resources if needed
  logger.log('Extension deactivated');
}

// Helper function to execute shell commands
async function executeCommand(command: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    cp.exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      
      if (stderr) {
        logger.log(`Command stderr: ${stderr}`);
      }
      
      resolve(stdout.trim());
    });
  });
} 