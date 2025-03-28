import * as vscode from 'vscode';
import * as cp from 'child_process';
import { GoSymbolCompletionProvider } from './goSymbolCompletionProvider';
import { GoSymbolCache } from './goSymbolCache';

export class Logger {
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Go Symbol Completion');
  }

  public log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
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
  
  // Initialize the symbol cache and index built-in packages
  try {
    logger.log('Starting symbol indexing...');
    await symbolCache.initialize();
    logger.log('Symbol indexing completed');
  } catch (error) {
    logger.log(`Error initializing symbol cache: ${error instanceof Error ? error.message : String(error)}`);
  }
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