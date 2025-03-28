import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { logger } from './extension';

// Represents a Go symbol with its package and details
export interface GoSymbol {
  name: string;           // Symbol name
  packagePath: string;    // Full package path
  packageName: string;    // Short package name
  kind: string;           // Symbol kind (function, type, const, var)
  signature?: string;     // For functions/methods, the signature
  isExported: boolean;    // Whether the symbol is exported
}

// Interface for persistent cache data format
interface CacheData {
  version: number;        // Cache format version
  goVersion: string;      // Go version used to build the cache
  timestamp: number;      // When the cache was created
  packages: {             // Map of indexed packages and their versions
    [packagePath: string]: string; // packagePath -> version
  };
  symbols: {              // Serialized symbols map
    [symbolName: string]: GoSymbol[];
  };
  processedPackages: string[]; // List of packages that have been fully processed
}

// Cache version to increment when format changes
const CACHE_VERSION = 2;

// Common Go packages to pre-cache for better startup performance
const COMMON_PACKAGES = [
  "k8s.io/client-go/kubernetes",
  "k8s.io/client-go/tools/clientcmd",
  "k8s.io/apimachinery/pkg/apis/meta/v1",
  "k8s.io/apimachinery/pkg/api/errors",
  "context",
  "os",
  "io",
  "fmt",
  "log",
  "net/http",
  "encoding/json",
  "time",
  "sync",
  "strings",
  "strconv",
  "reflect",
  "errors",
  "sort"
];

export class GoSymbolCache {
  private symbols: Map<string, GoSymbol[]> = new Map();
  private initialized: boolean = false;
  private initializing: boolean = false;
  private initializedCommonPackages: boolean = false;
  private workspaceModules: string[] = [];
  private tempFilePath: string;
  private cachePath: string;
  private indexedPackages: Map<string, string> = new Map(); // packagePath -> version
  private goVersion: string = '';
  
  constructor() {
    // Create a temporary file for passing package lists to Go
    this.tempFilePath = path.join(os.tmpdir(), `go-symbols-${Date.now()}.txt`);
    
    // Set up cache directory in global storage
    const cacheDir = path.join(os.homedir(), '.vscode', 'go-symbol-completion-cache');
    this.cachePath = path.join(cacheDir, 'symbol-cache.json');
    
    // Ensure the cache directory exists
    if (!fs.existsSync(cacheDir)) {
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
      } catch (error) {
        logger.log(`Failed to create cache directory: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  
  /**
   * Initialize the symbol cache by scanning Go packages
   */
  public async initialize(): Promise<void> {
    if (this.initialized || this.initializing) {
      return;
    }
    
    this.initializing = true;
    logger.log("Starting initialization of Go symbol cache...");
    
    try {
      // Get current Go version for cache validation
      this.goVersion = await this.getGoVersion();
      logger.log(`Detected Go version: ${this.goVersion}`);
      
      // First get workspace modules (for handling internal packages correctly)
      this.workspaceModules = await this.getWorkspaceModules();
      logger.log(`Detected workspace modules: ${this.workspaceModules.join(', ') || 'none'}`);
      
      // Try to load cache from disk
      const loadedFromDisk = await this.loadCacheFromDisk();
      if (loadedFromDisk) {
        logger.log("Successfully loaded symbol cache from disk");
        this.initialized = true;
        
        // Still initialize common packages in the background if needed
        if (!this.initializedCommonPackages) {
          this.initializeCommonPackages().catch(err => {
            logger.log(`Error initializing common packages in background: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        
        return;
      }
      
      // Quick initialization with common packages for fast startup
      await this.initializeCommonPackages();
      
      // Mark as initialized so completion can start working with common packages
      this.initialized = true;
      
      // Continue loading the full package list in the background
      this.initializeAllPackagesInBackground();
    } catch (error) {
      logger.log(`Error initializing symbol cache: ${error instanceof Error ? error.message : String(error)}`);
      vscode.window.showErrorMessage(`Failed to initialize Go symbol cache: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      this.initializing = false;
    }
  }
  
  /**
   * Get the current Go version
   */
  private async getGoVersion(): Promise<string> {
    try {
      const output = await this.execCommand('go version');
      // Parse version from output like "go version go1.21.0 darwin/amd64"
      const match = output.match(/go version go(\S+)/);
      return match ? match[1] : 'unknown';
    } catch (error) {
      logger.log(`Failed to get Go version: ${error instanceof Error ? error.message : String(error)}`);
      return 'unknown';
    }
  }
  
  /**
   * Load the symbol cache from disk if it exists and is valid
   */
  private async loadCacheFromDisk(): Promise<boolean> {
    try {
      // Check if cache file exists
      if (!fs.existsSync(this.cachePath)) {
        logger.log("No cache file found on disk");
        return false;
      }
      
      // Read and parse the cache file
      const cacheContent = await fs.promises.readFile(this.cachePath, 'utf-8');
      const cacheData = JSON.parse(cacheContent) as CacheData;
      
      // Validate cache format version
      if (cacheData.version !== CACHE_VERSION) {
        logger.log(`Cache version mismatch: expected ${CACHE_VERSION}, got ${cacheData.version}`);
        return false;
      }
      
      // Validate Go version
      if (cacheData.goVersion !== this.goVersion) {
        logger.log(`Go version changed: cache=${cacheData.goVersion}, current=${this.goVersion}`);
        return false;
      }
      
      // Convert serialized symbols back to Map
      this.symbols = new Map();
      for (const [name, syms] of Object.entries(cacheData.symbols)) {
        this.symbols.set(name, syms);
      }
      
      // Store indexed packages
      this.indexedPackages = new Map(Object.entries(cacheData.packages));
      
      // Process the list of processed packages if available (for backward compatibility)
      let processedPackagesList: string[] = [];
      if (cacheData.processedPackages && Array.isArray(cacheData.processedPackages)) {
        processedPackagesList = cacheData.processedPackages;
        logger.log(`Loaded ${processedPackagesList.length} processed packages from cache`);
      } else {
        // For backward compatibility with older cache format
        logger.log("Cache doesn't contain processed packages list, will rebuild incrementally");
        processedPackagesList = Array.from(this.indexedPackages.keys());
      }
      
      // Check if package versions have changed in the workspace
      const workspaceVersionsChanged = await this.haveWorkspacePackagesChanged();
      if (workspaceVersionsChanged) {
        logger.log("Workspace package versions have changed, rebuilding cache");
        // Clear the cache but return true so we don't show an error
        this.symbols = new Map();
        this.indexedPackages = new Map();
        return false;
      }
      
      logger.log(`Loaded ${this.symbols.size} symbols from cache, covering ${this.indexedPackages.size} packages`);
      this.initializedCommonPackages = true; // Assume cache included common packages
      return true;
    } catch (error) {
      logger.log(`Error loading cache from disk: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  
  /**
   * Check if workspace packages have changed versions
   */
  private async haveWorkspacePackagesChanged(): Promise<boolean> {
    try {
      // Get current workspace package versions
      const currentVersions = await this.getWorkspacePackageVersions();
      
      // Compare with cached versions
      for (const [pkg, version] of currentVersions) {
        const cachedVersion = this.indexedPackages.get(pkg);
        if (cachedVersion !== version) {
          logger.log(`Package version changed: ${pkg} was ${cachedVersion}, now ${version}`);
          return true;
        }
      }
      
      return false;
    } catch (error) {
      logger.log(`Error checking workspace packages: ${error instanceof Error ? error.message : String(error)}`);
      return true; // Assume changed on error
    }
  }
  
  /**
   * Get versions of workspace packages
   */
  private async getWorkspacePackageVersions(): Promise<Map<string, string>> {
    const versions = new Map<string, string>();
    
    try {
      // Get workspace folders
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return versions;
      }
      
      const cwd = workspaceFolders[0].uri.fsPath;
      
      // Try to get go.mod content
      try {
        const goModPath = path.join(cwd, 'go.mod');
        if (fs.existsSync(goModPath)) {
          const goModContent = await fs.promises.readFile(goModPath, 'utf-8');
          
          // Extract module name
          const moduleMatch = goModContent.match(/module\s+(.+)/);
          if (moduleMatch) {
            const moduleName = moduleMatch[1].trim();
            versions.set(moduleName, 'workspace');
          }
          
          // Extract dependencies
          const requirePattern = /require\s+([^\s]+)\s+([^\s]+)/g;
          let match;
          while ((match = requirePattern.exec(goModContent)) !== null) {
            const pkgName = match[1].trim();
            const pkgVersion = match[2].trim();
            versions.set(pkgName, pkgVersion);
          }
        }
      } catch (error) {
        logger.log(`Error processing go.mod: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      // Try go list -m all
      try {
        const output = await this.execCommand('go list -m all', { cwd });
        const lines = output.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            const pkgName = parts[0];
            const pkgVersion = parts[1];
            versions.set(pkgName, pkgVersion);
          } else if (parts.length === 1) {
            // Main module
            versions.set(parts[0], 'workspace');
          }
        }
      } catch (error) {
        logger.log(`Error getting module list: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      logger.log(`Error getting workspace package versions: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    return versions;
  }
  
  /**
   * Save the symbol cache to disk
   */
  private async saveCacheToDisk(): Promise<void> {
    try {
      logger.log("Saving symbol cache to disk...");
      
      // Verify we have data to save
      if (this.symbols.size === 0) {
        logger.log("No symbols in memory to save - skipping cache write");
        return;
      }
      
      // Log symbol count for debugging
      let totalSymbolCount = 0;
      for (const symbolList of this.symbols.values()) {
        totalSymbolCount += symbolList.length;
      }
      logger.log(`Preparing to save ${this.symbols.size} unique symbols (${totalSymbolCount} total) from ${this.indexedPackages.size} packages`);
      
      // Convert Maps to serializable objects
      const packagesObj: { [key: string]: string } = {};
      for (const [pkg, version] of this.indexedPackages.entries()) {
        packagesObj[pkg] = version;
      }
      
      const symbolsObj: { [key: string]: GoSymbol[] } = {};
      for (const [name, symbols] of this.symbols.entries()) {
        symbolsObj[name] = symbols;
      }
      
      // Get the list of processed packages from indexed packages
      const processedPackages = Array.from(this.indexedPackages.keys());
      
      // Create cache data structure
      const cacheData: CacheData = {
        version: CACHE_VERSION,
        goVersion: this.goVersion,
        timestamp: Date.now(),
        packages: packagesObj,
        symbols: symbolsObj,
        processedPackages: processedPackages
      };
      
      // Verify the data structure has content
      if (Object.keys(symbolsObj).length === 0) {
        logger.log("WARNING: No symbols to save, but indexedPackages.size is " + this.indexedPackages.size);
      }
      
      // Ensure directory exists
      const cacheDir = path.dirname(this.cachePath);
      if (!fs.existsSync(cacheDir)) {
        logger.log(`Creating cache directory: ${cacheDir}`);
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      
      // Serialize data with safety checks
      let jsonData: string;
      try {
        jsonData = JSON.stringify(cacheData);
        logger.log(`Serialized cache data: ${jsonData.length} bytes`);
        
        // Check that serialization produced valid content
        if (jsonData.length < 100 || !jsonData.includes('"symbols":{')) {
          logger.log(`WARNING: Serialized cache data appears too small or invalid: ${jsonData.substring(0, 100)}`);
        }
      } catch (jsonError) {
        logger.log(`Error serializing cache data: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
        return;
      }
      
      // Write file with explicit sync to ensure it's written
      const tempPath = `${this.cachePath}.tmp`;
      try {
        // Write to a temporary file first
        await fs.promises.writeFile(tempPath, jsonData, 'utf-8');
        
        // Verify the file was written correctly
        const stats = await fs.promises.stat(tempPath);
        logger.log(`Temporary cache file size: ${stats.size} bytes`);
        
        if (stats.size < 100) {
          throw new Error("Cache file is suspiciously small, aborting save");
        }
        
        // Rename the temp file to the actual cache file (atomic operation)
        await fs.promises.rename(tempPath, this.cachePath);
        
        logger.log(`Cache saved to ${this.cachePath} with ${this.symbols.size} unique symbols (${totalSymbolCount} total) and ${processedPackages.length} processed packages`);
      } catch (fileError) {
        logger.log(`Error writing cache file: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
        
        // Try direct write as fallback
        try {
          logger.log("Attempting direct write as fallback...");
          await fs.promises.writeFile(this.cachePath, jsonData, 'utf-8');
          logger.log("Direct write succeeded");
        } catch (directError) {
          logger.log(`Direct write also failed: ${directError instanceof Error ? directError.message : String(directError)}`);
        }
      }
    } catch (error) {
      logger.log(`Error saving cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Initialize with just common packages for fast startup
   */
  private async initializeCommonPackages(): Promise<void> {
    if (this.initializedCommonPackages) {
      return;
    }
    
    logger.log("Pre-caching common Go packages for faster startup");
    
    try {
      // Filter out packages that don't exist in the current environment
      const existingPackages = await this.filterExistingPackages(COMMON_PACKAGES);
      logger.log(`Found ${existingPackages.length} common packages to pre-cache`);
      
      if (existingPackages.length > 0) {
        // Process these packages with our faster symbol extraction
        await this.extractSymbolsFromPackages(existingPackages);
      }
      
      this.initializedCommonPackages = true;
    } catch (error) {
      logger.log(`Error initializing common packages: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Initialize all packages in the background
   */
  private async initializeAllPackagesInBackground(): Promise<void> {
    logger.log("Starting background initialization of Go packages...");
    
    try {
      // Get the list of all Go packages
      const limitToDirectDeps = true; // For better performance
      const allPackages = await this.getAllGoPackages(limitToDirectDeps);
      logger.log(`Found ${allPackages.length} Go packages to potentially index`);
      
      // Get the list of packages that have already been processed
      const processedPackages = new Set(Array.from(this.indexedPackages.keys()));
      logger.log(`Already processed ${processedPackages.size} packages from previous sessions`);
      
      // Filter out packages that are already indexed
      const packagesToProcess = allPackages.filter(pkg => !processedPackages.has(pkg));
      logger.log(`Need to process ${packagesToProcess.length} new packages`);
      
      // If there's nothing to do, we're done
      if (packagesToProcess.length === 0) {
        logger.log("All packages are already indexed - indexing is complete");
        return;
      }
      
      // Process packages in batches for better responsiveness
      const batchSize = 20;
      let processedCount = 0;
      const totalToProcess = packagesToProcess.length;
      
      // Process in smaller batches and save progress after each batch
      for (let i = 0; i < packagesToProcess.length; i += batchSize) {
        const batch = packagesToProcess.slice(i, i + batchSize);
        
        // Process this batch
        await this.extractSymbolsFromPackages(batch);
        processedCount += batch.length;
        
        // Save progress after each batch
        await this.saveCacheToDisk();
        
        logger.log(`Indexing progress: ${processedCount}/${totalToProcess} packages (${Math.round(processedCount/totalToProcess*100)}%)`);
      }
      
      logger.log("Background indexing of all packages completed");
    } catch (error) {
      logger.log(`Error in background initialization: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Get a list of all Go packages in the workspace and dependencies
   */
  private async getAllGoPackages(limitToDirectDeps = true): Promise<string[]> {
    logger.log(`Executing Go package discovery (${limitToDirectDeps ? 'direct deps only' : 'all packages'})`);
    
    // Try to get the workspace folder to use as current working directory
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      logger.log("No workspace folders found");
      return [];
    }
    
    const cwd = workspaceFolders[0].uri.fsPath;
    
    // First, get standard library packages and workspace packages
    const packages = new Set<string>();
    
    try {
      // Get standard library packages
      const stdPackages = await this.execCommand('go list -e std', {
        cwd,
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024
      });
      
      if (stdPackages && stdPackages.trim() !== '') {
        stdPackages.split('\n')
          .map(line => line.trim())
          .filter(line => line)
          .forEach(pkg => packages.add(pkg));
      }
      
      // Get workspace packages
      try {
        const workspacePackages = await this.execCommand('go list -e ./...', {
          cwd,
          env: { ...process.env },
          maxBuffer: 10 * 1024 * 1024
        });
        
        if (workspacePackages && workspacePackages.trim() !== '') {
          workspacePackages.split('\n')
            .map(line => line.trim())
            .filter(line => line)
            .forEach(pkg => packages.add(pkg));
        }
      } catch (error) {
        logger.log(`Error getting workspace packages: ${error instanceof Error ? error.message : String(error)}, continuing`);
      }
      
      // Get all dependencies from go.mod
      try {
        const goModPackages = await this.getGoModDependencies(cwd);
        goModPackages.forEach(pkg => packages.add(pkg));
      } catch (error) {
        logger.log(`Error getting go.mod dependencies: ${error instanceof Error ? error.message : String(error)}, continuing`);
      }
      
      // Add well-known packages that might be missing
      this.addWellKnownPackages(packages);
      
      // Filter packages
      const filteredPackages = this.filterPackages(Array.from(packages));
      logger.log(`Filtered to ${filteredPackages.length} usable packages`);
      
      if (filteredPackages.length > 0) {
        logger.log(`First few packages: ${filteredPackages.slice(0, 5).join(', ')}`);
      }
      
      return filteredPackages;
    } catch (error) {
      logger.log(`Error getting packages: ${error instanceof Error ? error.message : String(error)}`);
      
      // Try fallback to just workspace packages
      try {
        const workspacePackages = await this.getWorkspaceGoPackages();
        logger.log(`Fallback - found ${workspacePackages.length} workspace packages`);
        return workspacePackages;
      } catch (fallbackError) {
        logger.log(`Fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
        return [];
      }
    }
  }
  
  /**
   * Get dependencies from go.mod file
   */
  private async getGoModDependencies(cwd: string): Promise<string[]> {
    const packages = new Set<string>();
    
    try {
      // Get direct dependencies from go.mod
      const goListMod = await this.execCommand('go list -m all', {
        cwd,
        env: { ...process.env }
      });
      
      if (goListMod && goListMod.trim() !== '') {
        const deps = goListMod.split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('MODULE'));
        
        // For each module, try to get its packages
        for (const dep of deps) {
          // Extract the module name (first column)
          const moduleName = dep.split(' ')[0];
          if (!moduleName || moduleName === cwd) continue;
          
          try {
            // Get packages in this module
            const modulePackages = await this.execCommand(`go list ${moduleName}/...`, {
              cwd,
              env: { ...process.env },
              silent: true,
              timeout: 5000 // 5 second timeout per module
            });
            
            if (modulePackages && modulePackages.trim() !== '') {
              modulePackages.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.includes('no Go files'))
                .forEach(pkg => packages.add(pkg));
            } else {
              // If we can't get subpackages, at least add the module itself
              packages.add(moduleName);
            }
          } catch (moduleError) {
            // If getting packages fails, just add the module as a package
            packages.add(moduleName);
          }
        }
      }
    } catch (error) {
      logger.log(`Error getting go.mod dependencies: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    return Array.from(packages);
  }
  
  /**
   * Add well-known packages that might be useful
   */
  private addWellKnownPackages(packages: Set<string>): void {
    // Add some common, well-known packages that users might expect to have completions for
    const wellKnownPackages = [
      "github.com/gin-gonic/gin",
      "github.com/gorilla/mux",
      "github.com/stretchr/testify/assert",
      "github.com/spf13/cobra",
      "github.com/spf13/viper",
      "github.com/prometheus/client_golang/prometheus",
      "go.uber.org/zap",
      "github.com/sirupsen/logrus",
      "gopkg.in/yaml.v2",
      "gopkg.in/yaml.v3",
      "github.com/go-sql-driver/mysql",
      "github.com/lib/pq",
      "github.com/jinzhu/gorm",
      "gorm.io/gorm",
      "encoding/json",
      "net/http",
      "context",
      "fmt",
      "os",
      "time",
      "io",
      "strings",
      "sync",
      "errors",
      "bytes",
      "io/ioutil",
      "regexp",
      "path/filepath",
      "database/sql",
      "k8s.io/api/core/v1",
      "k8s.io/api/apps/v1",
      "k8s.io/client-go/kubernetes",
      "k8s.io/client-go/rest",
      "k8s.io/client-go/tools/clientcmd",
      "k8s.io/apimachinery/pkg/apis/meta/v1"
    ];

    wellKnownPackages.forEach(pkg => packages.add(pkg));
    logger.log(`Added ${wellKnownPackages.length} well-known packages`);
  }
  
  /**
   * Filter the list of packages based on accessibility rules
   */
  private filterPackages(packages: string[]): string[] {
    return packages.filter(pkg => {
      // Always exclude vendor packages and main package
      if (pkg.includes('/vendor/') || pkg === 'main') {
        return false;
      }
      
      // Check if this is an internal package
      if (pkg.includes('/internal/')) {
        // For internal packages, only include those from workspace modules
        // since others won't be accessible
        return this.workspaceModules.some(module => pkg.startsWith(module));
      }
      
      // Include all other packages
      return true;
    });
  }
  
  /**
   * Filter the package list to only include packages that exist
   */
  private async filterExistingPackages(packages: string[]): Promise<string[]> {
    const existingPackages: string[] = [];
    
    for (const pkg of packages) {
      try {
        await this.execCommand(`go list ${pkg}`, { silent: true });
        existingPackages.push(pkg);
      } catch (error) {
        // Package doesn't exist, log it but keep continuing
        logger.log(`Package doesn't exist: ${pkg}, skipping`);
      }
    }
    
    return existingPackages;
  }
  
  /**
   * Execute a shell command and return its stdout
   */
  private async execCommand(command: string, options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    silent?: boolean;
    timeout?: number;
  } = {}): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      try {
        // Set defaults
        const maxBuffer = options.maxBuffer || 1024 * 1024 * 100; // 100 MB buffer
        
        // Log command if not silent
        if (!options.silent) {
          logger.log(`Executing command: ${command}${options.cwd ? ` (in ${options.cwd})` : ''}`);
        }
        
        const proc = child_process.exec(command, {
          cwd: options.cwd,
          env: options.env,
          maxBuffer: maxBuffer,
          timeout: options.timeout,
        });
        
        let stdout = '';
        let stderr = '';
        
        if (proc.stdout) {
          proc.stdout.on('data', (data) => {
            stdout += data.toString();
          });
        }
        
        if (proc.stderr) {
          proc.stderr.on('data', (data) => {
            stderr += data.toString();
          });
        }
        
        proc.on('close', (code) => {
          if (code === 0) {
            if (!options.silent && stderr && stderr.trim() !== '') {
              logger.log(`Command stderr: ${stderr}`);
            }
            resolve(stdout);
          } else {
            if (!options.silent) {
              logger.log(`Command failed: ${command}`);
              logger.log(`Error: ${stderr}`);
            }
            reject(new Error(`Command exited with code ${code}`));
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Get the module paths for the current workspace
   */
  private async getWorkspaceModules(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return [];
    }
    
    const modules: string[] = [];
    
    for (const folder of workspaceFolders) {
      const folderPath = folder.uri.fsPath;
      logger.log(`Getting module info for workspace folder: ${folderPath}`);
      
      try {
        // Run go list -m to get the module path
        const output = await this.execCommand('go list -m', {
          cwd: folderPath,
          env: process.env,
        });
        
        const moduleName = output.trim();
        if (moduleName) {
          logger.log(`Found module: ${moduleName}`);
          modules.push(moduleName);
        }
      } catch (error) {
        logger.log(`Error getting module info: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    return modules;
  }
  
  /**
   * Fallback method to get Go packages in the workspace
   */
  private async getWorkspaceGoPackages(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return [];
    }
    
    const packages: string[] = [];
    
    for (const folder of workspaceFolders) {
      const folderPath = folder.uri.fsPath;
      logger.log(`Scanning workspace folder: ${folderPath}`);
      
      try {
        const output = await this.execCommand('go list ./...', {
          cwd: folderPath,
          env: process.env,
        });
        
        const folderPackages = output.split('\n')
          .map(pkg => pkg.trim())
          .filter(pkg => pkg && pkg !== 'main');
        
        logger.log(`Found ${folderPackages.length} packages in workspace folder`);
        packages.push(...folderPackages);
      } catch (error) {
        logger.log(`Error scanning workspace folder: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    return packages;
  }
  
  /**
   * Extract symbols from the given packages using our Go helper
   */
  private async extractSymbolsFromPackages(packages: string[]): Promise<void> {
    if (packages.length === 0) {
      return;
    }
    
    try {
      logger.log(`Extracting symbols from ${packages.length} packages using Go helper...`);
      logger.log(`First few packages: ${packages.slice(0, 5).join(', ')}`);
      
      // Write package list to temp file
      await fs.promises.writeFile(this.tempFilePath, packages.join('\n'));
      logger.log(`Wrote package list to ${this.tempFilePath}`);
      
      // Find the Go helper program
      let helperPath = await this.findHelperPath();
      
      if (!helperPath) {
        logger.log('Could not find Go helper script in any location. Symbol extraction will not work.');
        return;
      }
      
      // Debug the Go helper script content to verify it's the correct file
      try {
        const helperContent = await fs.promises.readFile(helperPath, 'utf-8');
        logger.log(`Helper script size: ${helperContent.length} bytes`);
        logger.log(`Helper script first 100 chars: ${helperContent.substring(0, 100)}`);
      } catch (readError) {
        logger.log(`Failed to read helper script: ${readError instanceof Error ? readError.message : String(readError)}`);
      }
      
      // Get debug level from VS Code configuration
      const config = vscode.workspace.getConfiguration('goSymbolCompletion');
      const debugLevel = config.get<number>('debugLevel', 1);
      
      // Run the helper program with the package list - add a debug output
      const command = `go run ${helperPath} -packages=${this.tempFilePath} -verbose -v=${debugLevel}`;
      logger.log(`Running command: ${command}`);
      
      const result = await this.execCommand(command);
      
      if (!result) {
        logger.log('Extract symbols command returned empty result');
        return;
      }
      
      logger.log(`Got result of length: ${result.length} characters`);
      
      // Always log a sample of the result
      logger.log(`Result sample: ${result.substring(0, 500).replace(/\n/g, '\\n')}`);
      
      // Parse and process the results
      try {
        const data = JSON.parse(result);
        logger.log(`Successfully parsed JSON data with ${Object.keys(data).length} packages`);
        const symbolCount = this.processExtractedSymbols(data);
        logger.log(`Processed ${symbolCount} symbols from ${packages.length} packages`);
        
        // Store package versions for change detection
        this.updatePackageVersions(packages);
        
        // Save cache immediately after processing to avoid losing symbols
        logger.log("Saving cache to disk after symbol extraction");
        await this.saveCacheToDisk();
      } catch (jsonError) {
        logger.log(`Error parsing JSON output: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
        logger.log(`Invalid JSON output (first 300 chars): ${result.substring(0, 300).replace(/\n/g, '\\n')}`);
      }
    } catch (error) {
      logger.log(`Error extracting symbols: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Clean up the temporary file
      try {
        await fs.promises.unlink(this.tempFilePath);
      } catch (cleanupError) {
        // Ignore errors deleting temp file
      }
    }
  }
  
  /**
   * Update stored package versions for change detection
   */
  private async updatePackageVersions(packages: string[]): Promise<void> {
    try {
      // For standard library packages, just use the Go version
      for (const pkg of packages) {
        if (this.isStandardLibraryPackage(pkg) && !this.indexedPackages.has(pkg)) {
          this.indexedPackages.set(pkg, this.goVersion);
        }
      }
      
      // For external packages, try to get actual versions
      const externalPkgs = packages.filter(pkg => !this.isStandardLibraryPackage(pkg) && !this.indexedPackages.has(pkg));
      
      if (externalPkgs.length === 0) {
        return;
      }
      
      // Try to get workspace folders
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
      }
      
      const cwd = workspaceFolders[0].uri.fsPath;
      
      // Use go list -m to get versions
      for (const pkg of externalPkgs) {
        try {
          const pkgRoot = pkg.split('/')[0]; // Get root package
          const output = await this.execCommand(`go list -m ${pkgRoot}`, { 
            cwd,
            silent: true
          });
          
          if (output && output.trim()) {
            const parts = output.trim().split(/\s+/);
            if (parts.length >= 2) {
              this.indexedPackages.set(pkg, parts[1]);
            } else {
              this.indexedPackages.set(pkg, 'unknown');
            }
          } else {
            this.indexedPackages.set(pkg, 'unknown');
          }
        } catch (error) {
          // If we can't determine the version, just mark as unknown
          this.indexedPackages.set(pkg, 'unknown');
        }
      }
    } catch (error) {
      logger.log(`Error updating package versions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Find the Go helper script path with multiple fallbacks
   */
  private async findHelperPath(): Promise<string | undefined> {
    // Get the filename of the helper
    const helperFileName = 'go_extract_symbols.go';
    
    // Get directory paths
    const currentDir = process.cwd();
    const scriptDir = __dirname;
    
    logger.log(`Current working directory: ${currentDir}`);
    logger.log(`Script execution directory: ${scriptDir}`);
    
    // Try to get the extension path from VS Code API
    const extensionId = 'ij-go-symbol-completion';
    let extensionPath: string | undefined;
    
    try {
      extensionPath = vscode.extensions.getExtension(extensionId)?.extensionPath;
      logger.log(`VS Code extension path: ${extensionPath || 'not found'}`);
    } catch (error) {
      logger.log(`Error getting extension path: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Build a list of possible paths to try
    const possiblePaths: string[] = [];
    
    // If we found the extension path, look there first
    if (extensionPath) {
      possiblePaths.push(
        path.join(extensionPath, helperFileName),
        path.join(extensionPath, 'dist', helperFileName),
        path.join(extensionPath, 'src', helperFileName),
        path.join(extensionPath, 'dist', 'src', helperFileName)
      );
    }
    
    // Add paths based on current script location
    possiblePaths.push(
      path.join(scriptDir, helperFileName),
      path.join(scriptDir, '..', helperFileName),
      path.join(scriptDir, '..', 'src', helperFileName)
    );
    
    // Add paths based on current working directory
    possiblePaths.push(
      path.join(currentDir, helperFileName),
      path.join(currentDir, 'src', helperFileName),
      path.join(currentDir, 'dist', helperFileName)
    );
    
    // Try to infer extension directory from __dirname
    if (scriptDir.includes('extensions') || scriptDir.includes('.cursor')) {
      // Pattern like /path/to/extensions/publisher.extension-id-version/...
      // Or /path/to/.cursor/extensions/publisher.extension-id-version/...
      try {
        const parts = scriptDir.split(path.sep);
        // Find the extensions directory
        const extensionsIndex = parts.findIndex(p => p === 'extensions');
        if (extensionsIndex >= 0 && extensionsIndex < parts.length - 1) {
          // The extension root would be everything up to the extension ID directory
          const inferredRoot = parts.slice(0, extensionsIndex + 2).join(path.sep);
          logger.log(`Inferred extension root: ${inferredRoot}`);
          
          possiblePaths.push(
            path.join(inferredRoot, helperFileName),
            path.join(inferredRoot, 'dist', helperFileName),
            path.join(inferredRoot, 'src', helperFileName)
          );
        }
      } catch (error) {
        logger.log(`Error inferring extension path: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Ensure we have unique paths
    const uniquePaths = [...new Set(possiblePaths)];
    
    // Log the paths we're going to check
    logger.log(`Will check ${uniquePaths.length} possible locations for the helper script`);
    
    // Check all paths
    for (const p of uniquePaths) {
      logger.log(`Checking for Go helper script at: ${p}`);
      try {
        if (await this.fileExists(p)) {
          logger.log(`Found Go helper script at: ${p}`);
          return p;
        }
      } catch (error) {
        logger.log(`Error checking path ${p}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // If we got here, we couldn't find the file
    logger.log(`Could not find helper script ${helperFileName} in any location`);
    return undefined;
  }
  
  /**
   * Check if a file exists (Promise-based)
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.promises.stat(filePath);
      return stats.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
  
  /**
   * Process the extracted symbols from the Go helper and add them to the cache
   */
  private processExtractedSymbols(data: any): number {
    if (!data || !data.Packages || !Array.isArray(data.Packages)) {
      logger.log('Invalid data format from symbol extractor');
      // Add more detailed diagnostic information
      if (data) {
        logger.log(`Received data type: ${typeof data}`);
        if (typeof data === 'object') {
          logger.log(`Data keys: ${Object.keys(data).join(', ')}`);
        }
      }
      return 0;
    }
    
    let totalSymbols = 0;
    logger.log(`Processing ${data.Packages.length} packages from extractor`);
    
    // Keep track of packages with symbols for debugging
    const packagesWithSymbols: string[] = [];
    const packagesWithoutSymbols: string[] = [];
    
    for (const pkgData of data.Packages) {
      const packagePath = pkgData.ImportPath;
      const packageName = pkgData.Name;
      
      if (!packagePath || !packageName) {
        logger.log(`Skipping package with invalid path or name: ${JSON.stringify(pkgData)}`);
        continue;
      }
      
      let packageSymbolCount = 0;
      
      // Process functions
      if (pkgData.Functions && Array.isArray(pkgData.Functions)) {
        for (const func of pkgData.Functions) {
          if (func.Name) {
            this.addSymbol({
              name: func.Name,
              packagePath,
              packageName,
              kind: 'function',
              signature: func.Signature || '',
              isExported: func.IsExported
            });
            totalSymbols++;
            packageSymbolCount++;
          }
        }
      }
      
      // Process types
      if (pkgData.Types && Array.isArray(pkgData.Types)) {
        for (const type of pkgData.Types) {
          if (type.Name) {
            this.addSymbol({
              name: type.Name,
              packagePath,
              packageName,
              kind: type.Kind || 'type',
              isExported: type.IsExported
            });
            totalSymbols++;
            packageSymbolCount++;
          }
        }
      }
      
      // Process variables and constants
      if (pkgData.Variables && Array.isArray(pkgData.Variables)) {
        for (const variable of pkgData.Variables) {
          if (variable.Name) {
            this.addSymbol({
              name: variable.Name,
              packagePath,
              packageName,
              kind: variable.IsConstant ? 'const' : 'var',
              isExported: variable.IsExported
            });
            totalSymbols++;
            packageSymbolCount++;
          }
        }
      }
      
      // Track packages with/without symbols for debugging
      if (packageSymbolCount > 0) {
        packagesWithSymbols.push(packagePath);
      } else {
        packagesWithoutSymbols.push(packagePath);
      }
    }
    
    logger.log(`Processed ${totalSymbols} symbols from ${data.Packages.length} packages`);
    logger.log(`Packages with symbols: ${packagesWithSymbols.length}, without symbols: ${packagesWithoutSymbols.length}`);
    
    // Log some example packages with symbols for debugging
    if (packagesWithSymbols.length > 0) {
      logger.log(`Examples of packages with symbols: ${packagesWithSymbols.slice(0, 5).join(', ')}`);
    }
    
    // Log some examples of packages without symbols for debugging
    if (packagesWithoutSymbols.length > 0 && packagesWithoutSymbols.length < data.Packages.length) {
      logger.log(`Examples of packages without symbols: ${packagesWithoutSymbols.slice(0, 5).join(', ')}`);
    }
    
    return totalSymbols;
  }
  
  /**
   * Find symbols matching the given query string
   */
  public findSymbols(query: string, limit: number = 100): GoSymbol[] {
    if (!this.initialized) {
      logger.log("Symbol cache not initialized - can't search for symbols");
      return [];
    }
    
    logger.log(`Symbol cache status: ${this.symbols.size} unique symbols in cache`);
    logger.log(`Looking for completions matching: "${query}"`);
    
    // Convert query to lowercase for case-insensitive matching
    const lowerQuery = query.toLowerCase();
    const results: GoSymbol[] = [];
    
    // Check if query contains a package prefix (like "fmt.")
    const dotIndex = query.indexOf('.');
    if (dotIndex > 0) {
      logger.log(`Query "${query}" contains package prefix`);
      const pkgPrefix = query.substring(0, dotIndex);
      const symbolQuery = query.substring(dotIndex + 1);
      
      logger.log(`Searching for symbols that match "${symbolQuery}" in packages matching "${pkgPrefix}"`);
      
      // Score and collect all matching symbols
      const scoredMatches: Array<{symbol: GoSymbol, score: number}> = [];
      
      // Find symbols in packages matching the prefix
      for (const [symName, symbols] of this.symbols.entries()) {
        // Check each symbol
        for (const symbol of symbols) {
          // Only include if the package matches
          if (symbol.packageName.toLowerCase() === pkgPrefix.toLowerCase() ||
              symbol.packagePath.toLowerCase().includes(pkgPrefix.toLowerCase())) {
            
            // Calculate match score
            const score = this.calculateMatchScore(symName, symbolQuery);
            
            // If we have any match, add it to results
            if (score > 0) {
              scoredMatches.push({symbol, score});
            }
          }
        }
      }
      
      // Sort matches by score (higher is better)
      scoredMatches.sort((a, b) => b.score - a.score);
      
      // Add top matches up to limit
      results.push(...scoredMatches.slice(0, limit).map(item => item.symbol));
      
      logger.log(`Found ${scoredMatches.length} total matches, returning top ${results.length}`);
    } else {
      logger.log(`Searching for all symbols that match "${query}"`);
      
      // Score and collect all matching symbols
      const scoredMatches: Array<{symbol: GoSymbol, score: number}> = [];
      
      // Scan the full symbol list
      for (const [symName, symbols] of this.symbols.entries()) {
        // Calculate match score for this symbol name
        const score = this.calculateMatchScore(symName, query);
        
        // If we have any match, add all symbols with this name
        if (score > 0) {
          for (const symbol of symbols) {
            scoredMatches.push({symbol, score});
          }
        }
      }
      
      // Sort matches by score (higher is better)
      scoredMatches.sort((a, b) => b.score - a.score);
      
      // Add top matches up to limit
      results.push(...scoredMatches.slice(0, limit).map(item => item.symbol));
      
      logger.log(`Found ${scoredMatches.length} total matches, returning top ${results.length}`);
    }
    
    logger.log(`Returning ${results.length} completion results for "${query}"`);
    if (results.length > 0) {
      const samples = results.slice(0, Math.min(5, results.length));
      logger.log(`Sample results: ${samples.map(s => `${s.packagePath}.${s.name}`).join(', ')}`);
    } else {
      // Diagnostic logging: Try to see if there are any symbols that are close
      const similarSymbols: string[] = [];
      
      // Check specifically for near matches to the query
      if (query.length >= 3) {
        const partialMatchQuery = query.substring(0, query.length - 1).toLowerCase();
        logger.log(`Checking for partial matches with "${partialMatchQuery}"`);
        
        for (const [symName, _] of this.symbols.entries()) {
          if (symName.toLowerCase().startsWith(partialMatchQuery)) {
            similarSymbols.push(symName);
            if (similarSymbols.length >= 5) break;
          }
        }
        
        if (similarSymbols.length > 0) {
          logger.log(`No exact matches, but found similar symbols: ${similarSymbols.join(', ')}`);
        } else {
          logger.log(`No similar symbols found for partial match "${partialMatchQuery}"`);
        }
      }
    }
    
    return results;
  }
  
  /**
   * Calculate a match score between a symbol name and query
   * Returns a score where higher is better match, 0 means no match
   */
  private calculateMatchScore(symbolName: string, query: string): number {
    // Don't process empty queries
    if (!query || query.length === 0) {
      return 0;
    }
    
    // Both to lowercase for case-insensitive matching
    const lowerSymbol = symbolName.toLowerCase();
    const lowerQuery = query.toLowerCase();
    
    // Exact match is the best (100 points)
    if (lowerSymbol === lowerQuery) {
      return 100;
    }
    
    // Prefix match is next best (90 points)
    if (lowerSymbol.startsWith(lowerQuery)) {
      return 90;
    }
    
    // Check for continuous subsequence match (80 points)
    if (lowerSymbol.includes(lowerQuery)) {
      return 80;
    }
    
    // Now check for fuzzy matching - missing characters
    if (query.length >= 2) {
      // For fuzzy matching we need at least 2 characters for meaningful matches
      
      // First specific check for camelCase matching (NewForCon -> NewForConfig)
      // This handles cases where typing the uppercase letters in camelCase should match
      // For example "NFC" should match "NewForConfig"
      let camelScore = this.getCamelCaseMatchScore(symbolName, query);
      if (camelScore > 0) {
        // Scale camel case score to be between 75-80 points (just below substring)
        return 75 + Math.floor(camelScore * 5);
      }
      
      // Check for fuzzy match where we allow skipped characters
      // Score based on percentage of matching characters
      let fuzzyScore = this.getFuzzyMatchScore(lowerSymbol, lowerQuery);
      
      // Lower threshold to 50% for fewer characters
      const threshold = query.length <= 3 ? 0.5 : 0.6;
      
      // Only consider valid if we match at least the threshold percentage of characters
      if (fuzzyScore >= threshold) {
        // Scale the fuzzy score to be between 50-70 points (below substring but above nothing)
        return 50 + Math.floor(fuzzyScore * 20);
      }
    }
    
    // No match
    return 0;
  }
  
  /**
   * Specialized matching for camelCase identifiers
   * Returns score 0-1, where 1 is perfect match
   */
  private getCamelCaseMatchScore(symbol: string, query: string): number {
    // If query is longer than symbol, can't be a match
    if (query.length > symbol.length) return 0;
    
    // For camelCase matching, check if query characters match capitals or beginnings of words
    const queryChars = query.split('');
    
    // Build pattern of capital letters plus first letters
    const camelPattern: string[] = [];
    let lastWasLower = false;
    
    // Add the first character always
    if (symbol.length > 0) {
      camelPattern.push(symbol[0].toLowerCase());
    }
    
    // Find capital letters and first letters after non-letters (like underscores)
    for (let i = 1; i < symbol.length; i++) {
      const char = symbol[i];
      const isUpper = char === char.toUpperCase() && char !== char.toLowerCase();
      const prevChar = symbol[i-1];
      const prevIsNonLetter = !prevChar.match(/[a-zA-Z]/);
      
      if (isUpper || prevIsNonLetter) {
        camelPattern.push(char.toLowerCase());
      }
    }
    
    // Early exit if the query is longer than our pattern
    if (query.length > camelPattern.length) return 0;
    
    // Check if query is a prefix of the camel pattern
    const lowerQuery = query.toLowerCase();
    const patternStart = camelPattern.slice(0, query.length).join('');
    
    if (patternStart === lowerQuery) {
      return 1.0; // Perfect camelCase match
    }
    
    // Check if query characters match a subsequence of the pattern
    let patternIdx = 0;
    let queryIdx = 0;
    
    while (queryIdx < lowerQuery.length && patternIdx < camelPattern.length) {
      if (lowerQuery[queryIdx] === camelPattern[patternIdx]) {
        queryIdx++;
      }
      patternIdx++;
    }
    
    // If we matched all query characters, calculate a score based on how much of the pattern we needed
    if (queryIdx === lowerQuery.length) {
      return queryIdx / patternIdx; // Reward using fewer pattern characters
    }
    
    return 0; // No match
  }
  
  /**
   * Calculate a fuzzy match score between symbol and query
   * Returns value from 0.0 to 1.0, higher is better match
   */
  private getFuzzyMatchScore(symbol: string, query: string): number {
    if (query.length === 0) return 0;
    if (query.length > symbol.length) return 0;
    
    let i = 0, j = 0;
    let matches = 0;
    let lastMatchPos = -1;
    let consecutiveMatches = 0;
    let longestConsecutive = 0;
    
    // Count matched characters in order
    while (i < symbol.length && j < query.length) {
      if (symbol[i] === query[j]) {
        matches++;
        
        // Track consecutive matches
        if (lastMatchPos === i - 1) {
          consecutiveMatches++;
          longestConsecutive = Math.max(longestConsecutive, consecutiveMatches);
        } else {
          consecutiveMatches = 1;
        }
        
        lastMatchPos = i;
        j++;
      }
      i++;
    }
    
    // If we matched all query characters, calculate a score
    if (j === query.length) {
      // Base score is percentage of characters matched
      const charMatchPercent = matches / query.length;
      
      // Bonus for consecutive characters - fewer gaps is better
      const gapPenalty = (lastMatchPos - matches + 1) / symbol.length;
      
      // Bonus for matching characters at the start (20% bonus)
      const startMatchBonus = symbol.startsWith(query[0]) ? 0.2 : 0;
      
      // Bonus for having consecutive matches (up to 20% bonus)
      const consecutiveBonus = (longestConsecutive / query.length) * 0.2;
      
      // Calculate final score, ensuring it's between 0 and 1
      return Math.min(1.0, Math.max(0, charMatchPercent - gapPenalty + startMatchBonus + consecutiveBonus));
    }
    
    return 0;
  }
  
  /**
   * Add a symbol to the cache
   */
  private addSymbol(symbol: GoSymbol): void {
    // Debug full symbol object
    logger.log(`Adding symbol (debug): ${JSON.stringify(symbol)}`);
    
    if (!symbol.name || !symbol.isExported) {
      logger.log(`Skipping symbol due to: name=${!!symbol.name}, isExported=${!!symbol.isExported}`);
      return;
    }
    
    // Remove any potential transformations that might be affecting the name
    const name = symbol.name.trim();
    
    // Log the addition of the symbol for debugging
    logger.log(`Adding symbol: ${name} from ${symbol.packagePath} (kind: ${symbol.kind}, isExported: ${symbol.isExported})`);
    
    if (!this.symbols.has(name)) {
      this.symbols.set(name, []);
    }
    
    this.symbols.get(name)!.push({
      ...symbol,
      name
    });
    
    // Debug total symbols count after adding
    logger.log(`Symbol count after adding: ${this.symbols.size} unique symbols`);
  }
  
  /**
   * Get debug information about the symbol cache
   */
  public getDebugInfo(showAll: boolean = false): string {
    if (!this.initialized) {
      return "Symbol cache not initialized - can't show debug info";
    }
    
    // Categorize symbols by package source
    const stdLibSymbols = new Set<string>();
    const externalSymbols = new Set<string>();
    let stdLibCount = 0;
    let externalCount = 0;
    
    for (const [name, symbols] of this.symbols.entries()) {
      for (const symbol of symbols) {
        if (this.isStandardLibraryPackage(symbol.packagePath)) {
          stdLibSymbols.add(name);
          stdLibCount++;
        } else {
          externalSymbols.add(name);
          externalCount++;
        }
      }
    }
    
    let output = `Symbol cache contains ${this.symbols.size} unique symbol names\n\n`;
    output += `Standard library symbols: ${stdLibSymbols.size} unique names (${stdLibCount} total symbols)\n`;
    output += `External package symbols: ${externalSymbols.size} unique names (${externalCount} total symbols)\n\n`;
    
    let totalSymbols = 0;
    for (const symbols of this.symbols.values()) {
      totalSymbols += symbols.length;
    }
    
    output += `Total symbols: ${totalSymbols}\n\n`;
    
    if (showAll) {
      output += `All symbols:\n`;
      
      // Get sorted symbols
      const sortedSymbols = [...this.symbols.entries()].sort((a, b) => 
        a[0].localeCompare(b[0])
      );
      
      for (const [name, symbols] of sortedSymbols) {
        output += `${name}:\n`;
        
        // Group by package and kind
        const byPackage = new Map<string, GoSymbol[]>();
        
        for (const symbol of symbols) {
          const key = `${symbol.packagePath} (${symbol.kind})`;
          if (!byPackage.has(key)) {
            byPackage.set(key, []);
          }
          byPackage.get(key)!.push(symbol);
        }
        
        for (const [key, items] of byPackage.entries()) {
          if (items.length === 1) {
            output += `  - ${key}\n`;
          } else {
            output += `  - ${key} (${items.length} items)\n`;
          }
        }
      }
    } else {
      // Just show a sample of symbols
      output += `Sample symbols:\n`;
      
      // Get 5 standard library and 5 external symbols to show as a sample
      const stdLibSample = Array.from(stdLibSymbols).slice(0, 5);
      const externalSample = Array.from(externalSymbols).slice(0, 5);
      
      output += `\nStandard library samples:\n`;
      for (const name of stdLibSample) {
        const symbols = this.symbols.get(name) || [];
        output += `${name}:\n`;
        
        // Group by package
        const byPackage = new Map<string, GoSymbol[]>();
        
        for (const symbol of symbols) {
          if (this.isStandardLibraryPackage(symbol.packagePath)) {
            const key = `${symbol.packagePath} (${symbol.kind})`;
            if (!byPackage.has(key)) {
              byPackage.set(key, []);
            }
            byPackage.get(key)!.push(symbol);
          }
        }
        
        let count = 0;
        for (const [key, items] of byPackage.entries()) {
          if (count < 3) { // Show max 3 packages per symbol
            if (items.length === 1) {
              output += `  - ${key}\n`;
            } else {
              output += `  - ${key} (${items.length} items)\n`;
            }
            count++;
          } else {
            output += `  - ... and ${byPackage.size - 3} more\n`;
            break;
          }
        }
      }
      
      output += `\nExternal package samples:\n`;
      for (const name of externalSample) {
        const symbols = this.symbols.get(name) || [];
        output += `${name}:\n`;
        
        // Group by package
        const byPackage = new Map<string, GoSymbol[]>();
        
        for (const symbol of symbols) {
          if (!this.isStandardLibraryPackage(symbol.packagePath)) {
            const key = `${symbol.packagePath} (${symbol.kind})`;
            if (!byPackage.has(key)) {
              byPackage.set(key, []);
            }
            byPackage.get(key)!.push(symbol);
          }
        }
        
        let count = 0;
        for (const [key, items] of byPackage.entries()) {
          if (count < 3) { // Show max 3 packages per symbol
            if (items.length === 1) {
              output += `  - ${key}\n`;
            } else {
              output += `  - ${key} (${items.length} items)\n`;
            }
            count++;
          } else {
            output += `  - ... and ${byPackage.size - 3} more\n`;
            break;
          }
        }
      }
    }
    
    return output;
  }
  
  /**
   * Helper method to check if a package is from the standard library
   */
  private isStandardLibraryPackage(packagePath: string): boolean {
    // Standard library packages don't have a dot in their path
    return !packagePath.includes('.');
  }

  /**
   * Get all symbols from the cache - for debugging
   */
  public getAllSymbols(): Map<string, GoSymbol[]> {
    return this.symbols;
  }
} 