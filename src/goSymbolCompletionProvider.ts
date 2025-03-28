import * as vscode from 'vscode';
import { GoSymbolCache, GoSymbol } from './goSymbolCache';
import { logger } from './extension';

export class GoSymbolCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private symbolCache: GoSymbolCache) {}
  
  public async provideCompletionItems(
    document: vscode.TextDocument, 
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
    // Check if we're in a Go file
    if (document.languageId !== 'go') {
      return [];
    }
    
    // Get the current line up to the cursor position
    const linePrefix = document.lineAt(position).text.substring(0, position.character);
    
    // Check if we're in a comment or string
    if (this.isInCommentOrString(linePrefix)) {
      return [];
    }
    
    // Try to get the current identifier being typed
    const currentWord = this.getCurrentIdentifier(linePrefix);
    if (!currentWord) {
      return [];
    }
    
    logger.log(`Looking for completions matching: "${currentWord}"`);
    
    // Find matching symbols
    const symbols = this.symbolCache.findSymbols(currentWord);
    
    logger.log(`Found ${symbols.length} completion suggestions for "${currentWord}"`);
    if (symbols.length > 0) {
      logger.log(`First ${Math.min(5, symbols.length)} matches:`);
      symbols.slice(0, 5).forEach((symbol, index) => {
        logger.log(`${index + 1}. ${symbol.packagePath}.${symbol.name} (${symbol.kind}${symbol.signature ? ': ' + symbol.signature : ''})`);
      });
    }
    
    // Convert to completion items
    return symbols.map(symbol => this.symbolToCompletionItem(symbol, document, currentWord));
  }
  
  /**
   * Convert a GoSymbol to a VSCode CompletionItem
   */
  private symbolToCompletionItem(
    symbol: GoSymbol, 
    document: vscode.TextDocument,
    query: string
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
      symbol.name,
      this.getCompletionItemKind(symbol.kind)
    );
    
    // Determine if we need to add the import
    const needsImport = !this.isImportedInDocument(document, symbol.packagePath);
    
    // Set label details
    item.detail = `${symbol.packagePath}.${symbol.name}`;
    
    // Extract the package name from the packagePath - properly handle versioned packages
    const packageParts = symbol.packagePath.split('/');
    let packageName = packageParts[packageParts.length - 1];
    
    // Add package prefix if it's not already in the query
    const hasPackagePrefix = query.includes('.');
    
    if (!hasPackagePrefix) {
      // Use the package name as a label suffix to help users identify the package
      item.label = {
        label: symbol.name,
        detail: ` - ${packageName}`
      };
      
      item.filterText = symbol.name;
      
      // We will insert only the symbol name initially
      item.insertText = symbol.name;
      
      // For functions, add signature information
      if (symbol.kind === 'func' && symbol.signature) {
        const snippetText = this.createFunctionSnippet(symbol.name, symbol.signature);
        item.insertText = new vscode.SnippetString(snippetText);
      }
      
      // Add additional text edit to import the package if needed
      if (needsImport) {
        // Create an additional edit to add the import statement
        // This will be applied automatically when the completion item is selected
        const importStatement = `import "${symbol.packagePath}"\n`;
        const firstLine = document.lineAt(0);
        item.additionalTextEdits = [
          vscode.TextEdit.insert(firstLine.range.start, importStatement)
        ];
      }
      
      // After insertion, we'll execute a command to replace the symbol with its package-qualified version
      const isFunctionWithParams = symbol.kind === 'func' && symbol.signature && symbol.signature.includes('(');
      const packagePrefixReplacement = `${packageName}.${symbol.name}${isFunctionWithParams ? '' : ''}`;
      
      item.command = {
        title: 'Add Package Prefix',
        command: 'editor.action.insertSnippet',
        arguments: [{
          snippet: packagePrefixReplacement + (isFunctionWithParams ? '($0)' : '')
        }]
      };
      
      // Make VS Code prefer this item in the list
      item.sortText = `0${symbol.name}`;
    } else {
      // If there's a package prefix, we're likely completing something like "pkg."
      // In this case, just insert the symbol name
      const parts = query.split('.');
      item.filterText = parts[parts.length - 1];
      item.insertText = symbol.name;
      
      // For functions, add signature information
      if (symbol.kind === 'func' && symbol.signature) {
        const snippetText = this.createFunctionSnippet(symbol.name, symbol.signature);
        item.insertText = new vscode.SnippetString(snippetText);
      }
    }
    
    // Add documentation
    item.documentation = new vscode.MarkdownString();
    item.documentation.appendCodeblock(`${symbol.packagePath}.${symbol.name}${symbol.signature || ''}`, 'go');
    
    if (needsImport && !hasPackagePrefix) {
      item.documentation.appendText('\n\n(Import will be added automatically)');
    }
    
    return item;
  }
  
  /**
   * Create a snippet for function completion with parameters
   */
  private createFunctionSnippet(funcName: string, signature: string): string {
    if (!signature || !signature.includes('(')) {
      return `${funcName}()`;
    }
    
    // Parse the function signature to extract parameters
    // Example: "func(config *rest.Config) (*Clientset, error)"
    const paramsPart = signature.substring(signature.indexOf('(') + 1, signature.indexOf(')'));
    const params = paramsPart.split(',').map(p => p.trim());
    
    if (params.length === 0 || params[0] === '') {
      return `${funcName}()`;
    }
    
    // Create a snippet with placeholders for each parameter
    let snippetText = `${funcName}(`;
    for (let i = 0; i < params.length; i++) {
      if (i > 0) {
        snippetText += ', ';
      }
      
      // Extract parameter name where possible
      const paramParts = params[i].split(' ');
      const paramName = paramParts.length > 1 ? paramParts[0] : `param${i + 1}`;
      
      snippetText += `\${${i + 1}:${paramName}}`;
    }
    snippetText += ')';
    
    return snippetText;
  }
  
  /**
   * Map Go symbol kinds to VS Code completion item kinds
   */
  private getCompletionItemKind(kind: string): vscode.CompletionItemKind {
    switch (kind.toLowerCase()) {
      case 'func':
        return vscode.CompletionItemKind.Function;
      case 'method':
        return vscode.CompletionItemKind.Method;
      case 'type':
        return vscode.CompletionItemKind.Class;
      case 'struct':
        return vscode.CompletionItemKind.Struct;
      case 'interface':
        return vscode.CompletionItemKind.Interface;
      case 'const':
        return vscode.CompletionItemKind.Constant;
      case 'var':
        return vscode.CompletionItemKind.Variable;
      case 'package':
        return vscode.CompletionItemKind.Module;
      default:
        return vscode.CompletionItemKind.Value;
    }
  }
  
  /**
   * Check if a package is already imported in the document
   */
  private isImportedInDocument(document: vscode.TextDocument, packagePath: string): boolean {
    const text = document.getText();
    
    // Simplistic check - in a real extension we would parse imports properly
    const importRegex = new RegExp(`import\\s+\\(([^)]*\\s+["']${this.escapeRegExp(packagePath)}["'][^)]*)\\)`, 's');
    const singleImportRegex = new RegExp(`import\\s+["']${this.escapeRegExp(packagePath)}["']`);
    
    return importRegex.test(text) || singleImportRegex.test(text);
  }
  
  /**
   * Escape special characters in a string for use in a regular expression
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  
  /**
   * Check if the cursor is inside a comment or string literal
   */
  private isInCommentOrString(linePrefix: string): boolean {
    // Simplistic check - in a real extension we would use a proper parser
    let inString = false;
    let inRawString = false;
    let inLineComment = false;
    let inBlockComment = false;
    
    for (let i = 0; i < linePrefix.length; i++) {
      const char = linePrefix[i];
      const nextChar = linePrefix[i + 1] || '';
      
      if (inLineComment) {
        // Line comment continues to the end
        return true;
      }
      
      if (inBlockComment) {
        if (char === '*' && nextChar === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }
      
      if (inString) {
        if (char === '\\') {
          // Skip escaped character
          i++;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      
      if (inRawString) {
        if (char === '`') {
          inRawString = false;
        }
        continue;
      }
      
      if (char === '/' && nextChar === '/') {
        inLineComment = true;
      } else if (char === '/' && nextChar === '*') {
        inBlockComment = true;
        i++;
      } else if (char === '"') {
        inString = true;
      } else if (char === '`') {
        inRawString = true;
      }
    }
    
    return inString || inRawString || inLineComment || inBlockComment;
  }
  
  /**
   * Extract the current identifier being typed
   */
  private getCurrentIdentifier(linePrefix: string): string | null {
    // Match a Go identifier with optional package prefix
    const match = linePrefix.match(/([a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]*)$/);
    if (!match) {
      return null;
    }
    
    return (match[1] || '') + (match[2] || '');
  }
} 