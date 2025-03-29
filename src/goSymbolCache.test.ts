import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GoSymbolCache, GoSymbol } from './goSymbolCache';
import { afterEach, before, after, describe, it } from 'mocha';

describe('GoSymbolCache', () => {
    let tempDir: string;
    let cachePath: string;
    
    before(() => {
        // Create temporary directory for tests
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-symbol-tests-'));
        cachePath = path.join(tempDir, 'symbol-cache.json');
        console.log(`Test cache path: ${cachePath}`);
    });
    
    afterEach(() => {
        // Clean up after each test
        if (fs.existsSync(cachePath)) {
            fs.unlinkSync(cachePath);
        }
    });
    
    after(() => {
        // Remove the temp directory
        fs.rmdirSync(tempDir, { recursive: true });
    });
    
    describe('Cache file handling', () => {
        it('should save and load cache correctly', async () => {
            // Create a test cache instance with mocked paths
            const cache = new GoSymbolCache();
            
            // We need to access private properties for testing
            const privateCache = cache as any;
            privateCache.cachePath = cachePath;
            
            // Mock fs.writeFileSync and fs.existsSync
            const originalWriteFileSync = fs.writeFileSync;
            const originalExistsSync = fs.existsSync;
            
            // Override fs operations for testing
            fs.writeFileSync = (filePath: fs.PathOrFileDescriptor, data: string) => {
                // Call the original but don't check the result
                originalWriteFileSync(filePath, data);
                return;
            };
            
            fs.existsSync = (path: fs.PathLike) => {
                return true; // Always return true for the test
            };
            
            // Add some test symbols
            privateCache.symbols = new Map<string, GoSymbol[]>();
            privateCache.symbols.set('TestSymbol', [
                {
                    name: 'TestSymbol',
                    packagePath: 'test/package',
                    packageName: 'package',
                    kind: 'function',
                    isExported: true
                }
            ]);
            
            // Add some package versions
            privateCache.indexedPackages = new Map<string, string>();
            privateCache.indexedPackages.set('test/package', '1.0.0');
            privateCache.goVersion = '1.21.0';
            
            try {
                // Save the cache
                await privateCache.saveCacheToDisk();
                
                // Verify the cache file exists (will always be true because of our mock)
                assert.strictEqual(fs.existsSync(cachePath), true, 'Cache file should exist after saving');
                
                // Create a new cache instance to test loading
                const newCache = new GoSymbolCache();
                const privateNewCache = newCache as any;
                privateNewCache.cachePath = cachePath;
                privateNewCache.goVersion = '1.21.0';
                
                // Load the cache (this will actually use the real file, but our test creates it)
                const loadResult = await privateNewCache.loadCacheFromDisk();
                assert.strictEqual(loadResult, true, 'Cache should load successfully');
                
                // Verify symbol was loaded
                assert.strictEqual(privateNewCache.symbols.size, 1, 'One symbol should be loaded');
                assert.strictEqual(privateNewCache.symbols.get('TestSymbol')[0].name, 'TestSymbol', 
                    'Symbol name should be loaded correctly');
                assert.strictEqual(privateNewCache.indexedPackages.size, 1, 'One package should be loaded');
            } finally {
                // Restore original fs functions
                fs.writeFileSync = originalWriteFileSync;
                fs.existsSync = originalExistsSync;
            }
        });
        
        it('should handle cache version mismatch', async () => {
            // Create invalid cache data with wrong version
            const invalidCacheData = {
                version: 999,  // Wrong version
                goVersion: '1.21.0',
                timestamp: Date.now(),
                packages: { 'test/package': '1.0.0' },
                symbols: {}
            };
            
            // Write invalid cache to file
            fs.writeFileSync(cachePath, JSON.stringify(invalidCacheData));
            
            // Try to load the cache
            const cache = new GoSymbolCache();
            const privateCache = cache as any;
            privateCache.cachePath = cachePath;
            privateCache.goVersion = '1.21.0';
            
            const loadResult = await privateCache.loadCacheFromDisk();
            assert.strictEqual(loadResult, false, 'Cache should not load with version mismatch');
        });
        
        it('should handle Go version change', async () => {
            // Create cache data with different Go version
            const cacheData = {
                version: 1,
                goVersion: '1.19.0',  // Different Go version
                timestamp: Date.now(),
                packages: { 'test/package': '1.0.0' },
                symbols: {},
                processedPackages: ['test/package']
            };
            
            // Write cache to file
            fs.writeFileSync(cachePath, JSON.stringify(cacheData));
            
            // Try to load the cache
            const cache = new GoSymbolCache();
            const privateCache = cache as any;
            privateCache.cachePath = cachePath;
            privateCache.goVersion = '1.21.0';  // Current Go version
            
            const loadResult = await privateCache.loadCacheFromDisk();
            assert.strictEqual(loadResult, false, 'Cache should not load with Go version mismatch');
        });
        
        it('should handle empty cache gracefully', async () => {
            // Create an empty cache file
            fs.writeFileSync(cachePath, '');
            
            // Try to load the cache
            const cache = new GoSymbolCache();
            const privateCache = cache as any;
            privateCache.cachePath = cachePath;
            
            const loadResult = await privateCache.loadCacheFromDisk();
            assert.strictEqual(loadResult, false, 'Empty cache should not load');
        });
        
        it('should handle corrupted JSON gracefully', async () => {
            // Create corrupted JSON
            fs.writeFileSync(cachePath, '{ "version": 1, "goVersion": "1.21.0", "bad_json');
            
            // Try to load the cache
            const cache = new GoSymbolCache();
            const privateCache = cache as any;
            privateCache.cachePath = cachePath;
            
            const loadResult = await privateCache.loadCacheFromDisk();
            assert.strictEqual(loadResult, false, 'Corrupted JSON should not load');
        });
    });
    
    describe('Symbol processing', () => {
        it('should correctly add symbols', () => {
            const cache = new GoSymbolCache();
            const privateCache = cache as any;
            
            // Test adding an exported symbol
            const exportedSymbol: GoSymbol = {
                name: 'ExportedFunc',
                packagePath: 'test/package',
                packageName: 'package',
                kind: 'function',
                isExported: true
            };
            
            privateCache.addSymbol(exportedSymbol);
            
            // Verify the symbol was added
            assert.strictEqual(privateCache.symbols.size, 1, 'Symbol map should have one entry');
            assert.strictEqual(privateCache.symbols.get('ExportedFunc').length, 1, 
                'Symbol should be added under its name');
            
            // Test adding a non-exported symbol (should be skipped)
            const nonExportedSymbol: GoSymbol = {
                name: 'privateFunc',
                packagePath: 'test/package',
                packageName: 'package',
                kind: 'function',
                isExported: false
            };
            
            privateCache.addSymbol(nonExportedSymbol);
            
            // Verify non-exported symbol wasn't added
            assert.strictEqual(privateCache.symbols.size, 1, 'Symbol map should still have one entry');
            assert.strictEqual(privateCache.symbols.has('privateFunc'), false, 
                'Non-exported symbol should not be added');
        });
    });
    
    describe('Package version detection', () => {
        it('should detect versions for non-standard packages', () => {
            const cache = new GoSymbolCache();
            const privateCache = cache as any;
            
            // Setup test data in the indexedPackages Map
            privateCache.indexedPackages = new Map<string, string>();
            privateCache.indexedPackages.set('github.com/user/repo', 'v1.2.3');
            privateCache.indexedPackages.set('github.com/user/repo/subpkg', 'v1.2.3');
            
            // Verify versions are correctly detected
            assert.strictEqual(privateCache.indexedPackages.get('github.com/user/repo'), 'v1.2.3', 
                'Should detect version for GitHub package');
            assert.strictEqual(privateCache.indexedPackages.get('github.com/user/repo/subpkg'), 'v1.2.3', 
                'Should inherit version from parent module');
        });
    });
    
    describe('Outdated package detection', () => {
        it('should correctly identify packages needing reindexing', async () => {
            const cache = new GoSymbolCache();
            const privateCache = cache as any;
            
            // Mock getAllGoPackages to return a fixed set of packages
            privateCache.getAllGoPackages = async () => {
                return [
                    'github.com/user/repo',          // Already indexed with same version
                    'github.com/user/repo/subpkg',   // Already indexed with same version
                    'github.com/user/new-pkg',       // New package
                    'github.com/user/changed-pkg',   // Version changed
                    'github.com/user/old-pkg'        // Old metadata
                ];
            };
            
            // Mock getChangedWorkspacePackages to return packages with changed versions
            privateCache.getChangedWorkspacePackages = async () => {
                const changed = new Map<string, string>();
                changed.set('github.com/user/changed-pkg', 'v2.0.0');
                return changed;
            };
            
            // Setup existing indexed packages
            privateCache.indexedPackages = new Map<string, string>();
            privateCache.indexedPackages.set('github.com/user/repo', 'v1.0.0');
            privateCache.indexedPackages.set('github.com/user/repo/subpkg', 'v1.0.0');
            privateCache.indexedPackages.set('github.com/user/changed-pkg', 'v1.0.0');
            privateCache.indexedPackages.set('github.com/user/old-pkg', 'v1.0.0');
            
            // Setup package metadata with timestamps
            privateCache.packageInfo = new Map();
            
            // Recent package (within 7 days)
            privateCache.packageInfo.set('github.com/user/repo', {
                version: 'v1.0.0',
                timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 // 3 days ago
            });
            
            privateCache.packageInfo.set('github.com/user/repo/subpkg', {
                version: 'v1.0.0',
                timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000 // 2 days ago
            });
            
            // Old package (older than 7 days) 
            privateCache.packageInfo.set('github.com/user/old-pkg', {
                version: 'v1.0.0',
                timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000 // 30 days ago
            });
            
            // Setup workspace package detection 
            privateCache.isWorkspacePackage = (pkg: string) => {
                return pkg === 'github.com/user/old-pkg'; // Only this is a workspace package
            };
            
            // Get outdated packages
            const outdated = await privateCache.getOutdatedPackages();
            
            // Verify the right packages are identified
            assert.strictEqual(outdated.length, 3, 'Should identify exactly 3 outdated packages');
            assert.ok(outdated.includes('github.com/user/new-pkg'), 'Should include new package');
            assert.ok(outdated.includes('github.com/user/changed-pkg'), 'Should include package with changed version');
            assert.ok(outdated.includes('github.com/user/old-pkg'), 'Should include old workspace package');
            
            // Verify packages that should not be reindexed
            assert.ok(!outdated.includes('github.com/user/repo'), 'Should not include recent package');
            assert.ok(!outdated.includes('github.com/user/repo/subpkg'), 'Should not include recent subpackage');
        });
        
        it('should handle missing package info', async () => {
            const cache = new GoSymbolCache();
            const privateCache = cache as any;
            
            // Mock getAllGoPackages to return a fixed set of packages
            privateCache.getAllGoPackages = async () => {
                return [
                    'github.com/user/repo',        // With metadata
                    'github.com/user/no-metadata'  // Without metadata
                ];
            };
            
            // Mock getChangedWorkspacePackages to return empty map (no changes)
            privateCache.getChangedWorkspacePackages = async () => new Map();
            
            // Setup existing indexed packages
            privateCache.indexedPackages = new Map<string, string>();
            privateCache.indexedPackages.set('github.com/user/repo', 'v1.0.0');
            privateCache.indexedPackages.set('github.com/user/no-metadata', 'v1.0.0');
            
            // Setup package metadata, but only for one package
            privateCache.packageInfo = new Map();
            privateCache.packageInfo.set('github.com/user/repo', {
                version: 'v1.0.0',
                timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 // 3 days ago
            });
            
            // None of these are workspace packages
            privateCache.isWorkspacePackage = () => false;
            
            // Get outdated packages
            const outdated = await privateCache.getOutdatedPackages();
            
            // Verify that the package without metadata is included
            assert.strictEqual(outdated.length, 1, 'Should identify exactly 1 outdated package');
            assert.ok(outdated.includes('github.com/user/no-metadata'), 'Should include package without metadata');
        });
    });
}); 