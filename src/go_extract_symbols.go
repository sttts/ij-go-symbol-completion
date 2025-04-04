package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io/ioutil"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// Output structure
type SymbolOutput struct {
	Packages []PackageSymbols `json:"Packages"`
}

// Package symbols
type PackageSymbols struct {
	Name       string     `json:"name"`
	ImportPath string     `json:"importPath"`
	Functions  []Function `json:"functions"`
	Types      []Type     `json:"types"`
	Variables  []Variable `json:"variables"`
	Version    string     `json:"version,omitempty"`
}

// Function symbol
type Function struct {
	Name       string `json:"Name"`
	IsExported bool   `json:"IsExported"`
	Signature  string `json:"Signature"`
}

// Type symbol
type Type struct {
	Name       string `json:"Name"`
	Kind       string `json:"Kind"`
	IsExported bool   `json:"IsExported"`
}

// Variable symbol
type Variable struct {
	Name       string `json:"Name"`
	IsExported bool   `json:"IsExported"`
	IsConstant bool   `json:"IsConstant"`
}

var (
	packagesFile   = flag.String("packages", "", "Path to file containing package names, one per line")
	timeoutSeconds = flag.Int("timeout", 10, "Timeout in seconds for each package")
	verbose        = flag.Bool("verbose", false, "Enable verbose logging")
	debug          = flag.Bool("debug", false, "Enable debug mode with extra logging")
	verbosityLevel = flag.Int("v", 1, "Verbosity level (0=none, 1=basic, 2=detailed, 3=verbose)")
)

// logCommand logs command execution details to stderr based on verbosity level
func logCommand(cmd *exec.Cmd) {
	if *verbosityLevel >= 3 {
		fmt.Fprintf(os.Stderr, "DEBUG[3]: Executing command: %s\n", cmd.Path)
		fmt.Fprintf(os.Stderr, "DEBUG[3]: Working directory: %s\n", cmd.Dir)
	}
}

// logCommandResult logs command result based on success/failure and verbosity level
func logCommandResult(cmd *exec.Cmd, err error, output []byte) {
	if err != nil {
		// Always log failed commands at verbosity level 1
		fmt.Fprintf(os.Stderr, "DEBUG[1]: Command failed: %s\n", cmd.Path)
		fmt.Fprintf(os.Stderr, "DEBUG[1]: Error: %v\n", err)
		if len(output) > 0 {
			// Log a limited portion of the output to avoid overwhelming logs
			outputStr := string(output)
			if len(outputStr) > 500 {
				outputStr = outputStr[:500] + "... (truncated)"
			}
			fmt.Fprintf(os.Stderr, "DEBUG[1]: Output: %s\n", outputStr)
		}
	} else if *verbosityLevel >= 3 {
		// Only log successful commands at high verbosity
		if *verbose {
			fmt.Fprintf(os.Stderr, "DEBUG[3]: Command succeeded: %s\n", cmd.Path)
		}
	}
}

// debugLog logs messages only when debug mode is enabled or verbosity level is high enough
func debugLog(level int, format string, args ...interface{}) {
	if *debug || *verbosityLevel >= level {
		prefix := "DEBUG"
		if level > 1 {
			prefix = fmt.Sprintf("DEBUG[%d]", level)
		}
		fmt.Fprintf(os.Stderr, prefix+": "+format+"\n", args...)
	}
}

// verboseLog logs messages only when verbose mode is enabled or verbosity level is high
func verboseLog(format string, args ...interface{}) {
	if *verbose || *verbosityLevel >= 3 {
		fmt.Fprintf(os.Stderr, "VERBOSE: "+format+"\n", args...)
	}
}

// Create a temporary directory with retries
func createTempDirWithRetry(prefix string, maxRetries int) (string, error) {
	var tempDir string
	var err error

	for i := 0; i < maxRetries; i++ {
		tempDir, err = ioutil.TempDir("", prefix)
		if err != nil {
			debugLog(1, "Error creating temp directory (attempt %d/%d): %v", i+1, maxRetries, err)
			continue
		}

		// Check if go.mod already exists (this shouldn't happen for a fresh temp dir)
		goModPath := filepath.Join(tempDir, "go.mod")
		if _, statErr := os.Stat(goModPath); statErr == nil {
			// go.mod exists, try to remove it
			debugLog(1, "Found existing go.mod in temp directory, attempting to remove")
			if rmErr := os.Remove(goModPath); rmErr != nil {
				debugLog(1, "Failed to remove existing go.mod: %v", rmErr)
				// Try a different temp directory
				os.RemoveAll(tempDir)
				continue
			}
		}

		// Success
		return tempDir, nil
	}

	return "", fmt.Errorf("failed to create usable temp directory after %d attempts: %v", maxRetries, err)
}

func main() {
	// Parse command line flags
	flag.Parse()

	if *packagesFile == "" {
		fmt.Fprintf(os.Stderr, "Error: -packages flag is required\n")
		os.Exit(1)
	}

	// Log startup info
	debugLog(1, "Starting Go symbol extraction")
	debugLog(1, "Packages file: %s", *packagesFile)
	debugLog(2, "Current working directory: %s", getWorkingDir())

	// Ensure GO111MODULE is set to on for consistent behavior
	os.Setenv("GO111MODULE", "on")
	debugLog(2, "Set GO111MODULE=on")

	// Read package list
	content, err := ioutil.ReadFile(*packagesFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading packages file: %v\n", err)
		os.Exit(1)
	}

	// Parse package list
	packageList := strings.Split(string(content), "\n")
	var packages []string
	for _, pkg := range packageList {
		pkg = strings.TrimSpace(pkg)
		if pkg != "" {
			packages = append(packages, pkg)
		}
	}

	if len(packages) == 0 {
		fmt.Fprintf(os.Stderr, "Error: no packages found in file\n")
		os.Exit(1)
	}

	debugLog(1, "Found %d packages to analyze", len(packages))
	if *verbosityLevel >= 3 {
		debugLog(3, "Packages to analyze: %s", strings.Join(packages, ", "))
	}

	// Create temp directory for our module with retries
	tempDir, err := createTempDirWithRetry("go-symbols-extractor", 3)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating temp directory: %v\n", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tempDir)

	debugLog(2, "Created temporary directory: %s", tempDir)

	// Initialize a Go module with a higher Go version to support more modules
	goModContent := `module symbols-extractor

go 1.21
`

	err = ioutil.WriteFile(filepath.Join(tempDir, "go.mod"), []byte(goModContent), 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating go.mod file: %v\n", err)
		os.Exit(1)
	}
	debugLog(2, "Created go.mod in %s", tempDir)

	// Create a simple Go file to verify the module setup
	mainGoContent := `package main

func main() {
	// Empty main function to make the module valid
}
`
	err = ioutil.WriteFile(filepath.Join(tempDir, "main.go"), []byte(mainGoContent), 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating main.go file: %v\n", err)
		os.Exit(1)
	}
	debugLog(2, "Created main.go in %s", tempDir)

	// Verify the module setup
	cmd := exec.Command("go", "mod", "tidy")
	cmd.Dir = tempDir
	logCommand(cmd)
	cmdOutput, err := cmd.CombinedOutput()
	logCommandResult(cmd, err, cmdOutput)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error setting up module with go mod tidy: %v\n", err)
		// Continue anyway, as it might work for some packages
	}

	// Extract symbols
	output := SymbolOutput{
		Packages: make([]PackageSymbols, 0, len(packages)),
	}

	// Process standard library packages first
	stdLibPackages := make([]string, 0)
	externalPackages := make([]string, 0)

	for _, pkgPath := range packages {
		if isStandardLibrary(pkgPath) {
			stdLibPackages = append(stdLibPackages, pkgPath)
		} else {
			externalPackages = append(externalPackages, pkgPath)
		}
	}

	debugLog(1, "Found %d standard library packages and %d external packages",
		len(stdLibPackages), len(externalPackages))

	// First process standard library which doesn't need module setup
	for _, pkgPath := range stdLibPackages {
		debugLog(2, "Processing standard library package: %s", pkgPath)
		pkgSymbols, err := extractPackageSymbols(pkgPath, tempDir, *timeoutSeconds, *verbose)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error extracting symbols from %s: %v\n", pkgPath, err)
			continue
		}

		if pkgSymbols != nil {
			output.Packages = append(output.Packages, *pkgSymbols)
		}
	}

	// Then process external packages in batches to avoid overwhelming the system
	batchSize := 5
	for i := 0; i < len(externalPackages); i += batchSize {
		end := i + batchSize
		if end > len(externalPackages) {
			end = len(externalPackages)
		}

		batch := externalPackages[i:end]
		debugLog(2, "Processing batch %d to %d of external packages", i, end-1)

		for _, pkgPath := range batch {
			debugLog(2, "Processing external package: %s", pkgPath)

			pkgSymbols, err := extractPackageSymbols(pkgPath, tempDir, *timeoutSeconds, *verbose)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error extracting symbols from %s: %v\n", pkgPath, err)

				// Even if there's an error, still add a minimal package entry
				minimalSymbols := createMinimalPackageSymbols(pkgPath)
				output.Packages = append(output.Packages, *minimalSymbols)
				continue
			}

			if pkgSymbols != nil {
				output.Packages = append(output.Packages, *pkgSymbols)
			}
		}
	}

	// Output JSON
	jsonData, err := json.MarshalIndent(output, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error encoding JSON: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(string(jsonData))
}

// Get current working directory
func getWorkingDir() string {
	dir, err := os.Getwd()
	if err != nil {
		return "unknown"
	}
	return dir
}

// isProblematicPackage returns true if a package is known to cause issues
func isProblematicPackage(pkgPath string) bool {
	// We'll handle all external packages directly in the extraction function
	// rather than skipping specific patterns
	return false
}

// createMinimalPackageSymbols creates a minimal package entry with just the name and path
func createMinimalPackageSymbols(pkgPath string) *PackageSymbols {
	// Extract package name from the path (last component)
	parts := strings.Split(pkgPath, "/")
	pkgName := parts[len(parts)-1]

	// Handle special cases like versioned packages
	if strings.Contains(pkgName, "v1") || strings.Contains(pkgName, "v2") || strings.Contains(pkgName, "v3") {
		pkgName = strings.Split(pkgName, "v")[0]
	}

	// Make empty if blank
	if pkgName == "" {
		pkgName = "package"
	}

	return &PackageSymbols{
		Name:       pkgName,
		ImportPath: pkgPath,
		Functions:  []Function{},
		Types:      []Type{},
		Variables:  []Variable{},
	}
}

// isStandardLibrary checks if a package is part of the Go standard library
func isStandardLibrary(pkgPath string) bool {
	// Standard library packages don't have a dot in their import path
	return !strings.Contains(pkgPath, ".")
}

func extractPackageSymbols(pkgPath string, tempDir string, timeoutSeconds int, verbose bool) (*PackageSymbols, error) {
	// Create a context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	// For non-standard library packages, try a direct approach first
	if !isStandardLibrary(pkgPath) {
		// First try to get package info directly, which may work for already installed packages
		cmd := exec.CommandContext(ctx, "go", "list", "-json", pkgPath)
		logCommand(cmd)

		output, err := cmd.CombinedOutput()
		if err == nil {
			// We succeeded, so parse the output
			var pkgInfo struct {
				Name    string   `json:"Name"`
				PkgPath string   `json:"ImportPath"`
				Exports []string `json:"Exports"`
			}
			if jsonErr := json.Unmarshal(output, &pkgInfo); jsonErr == nil && pkgInfo.Name != "" {
				// Create package symbols with the information we have
				result := &PackageSymbols{
					Name:       pkgInfo.Name,
					ImportPath: pkgInfo.PkgPath,
					Functions:  []Function{},
					Types:      []Type{},
					Variables:  []Variable{},
				}

				// Process exported symbols
				for _, symbolName := range pkgInfo.Exports {
					processExportedSymbol(symbolName, result)
				}

				// Try to get more details if possible
				cmdDoc := exec.CommandContext(ctx, "go", "doc", "-all", pkgPath)
				logCommand(cmdDoc)

				docOutput, docErr := cmdDoc.CombinedOutput()
				if docErr == nil {
					parseDocOutput(string(docOutput), result)
				}

				return result, nil
			}
		}

		// If direct approach failed, set up a proper temporary module environment

		// Extract the module root from the package path
		// For example: cloud.google.com/go/dialogflow -> cloud.google.com/go
		moduleParts := strings.Split(pkgPath, "/")
		var moduleRoot string
		if len(moduleParts) >= 2 {
			if strings.Contains(moduleParts[0], ".") { // External module with domain
				if len(moduleParts) >= 3 {
					moduleRoot = strings.Join(moduleParts[:3], "/") // cloud.google.com/go
				} else {
					moduleRoot = strings.Join(moduleParts[:2], "/") // github.com/user
				}
			} else {
				moduleRoot = moduleParts[0] // Standard module like "context"
			}
		} else {
			moduleRoot = pkgPath
		}

		// Initialize a new Go module with the target package
		initCmd := exec.CommandContext(ctx, "go", "mod", "init", "symbols-extractor")
		initCmd.Dir = tempDir
		logCommand(initCmd)

		initOutput, initErr := initCmd.CombinedOutput()
		logCommandResult(initCmd, initErr, initOutput)
		if initErr != nil {
			debugLog(2, "Failed to initialize module: %v", initErr)
		} else {
			debugLog(2, "Successfully initialized new module")
		}

		// Create an empty go.sum file
		goSumPath := filepath.Join(tempDir, "go.sum")
		if _, err := os.Stat(goSumPath); os.IsNotExist(err) {
			if err := ioutil.WriteFile(goSumPath, []byte{}, 0644); err != nil {
				debugLog(2, "Failed to create empty go.sum: %v", err)
			} else {
				debugLog(2, "Created empty go.sum file")
			}
		}

		// Create a simple main.go file to make the module valid
		mainGoContent := `package main

import (
	_ "` + pkgPath + `" // Import the target package
)

func main() {
	// Empty function to make the module valid
}
`
		mainGoPath := filepath.Join(tempDir, "main.go")
		if err := ioutil.WriteFile(mainGoPath, []byte(mainGoContent), 0644); err != nil {
			debugLog(2, "Failed to create main.go: %v", err)
		} else {
			debugLog(2, "Created main.go with import for %s", pkgPath)
		}

		// Try download with mod download - ignoring errors since we'll verify later
		dlCmd := exec.CommandContext(ctx, "go", "mod", "download", "-x")
		dlCmd.Dir = tempDir
		logCommand(dlCmd)

		dlOutput, dlErr := dlCmd.CombinedOutput()
		logCommandResult(dlCmd, dlErr, dlOutput)
		if dlErr != nil {
			debugLog(2, "mod download warning (continuing): %v", dlErr)
		} else {
			debugLog(2, "Successfully downloaded modules")
		}

		// Add the specific module as a requirement using go get
		getCmd := exec.CommandContext(ctx, "go", "get", "-d", pkgPath)
		getCmd.Dir = tempDir
		logCommand(getCmd)

		getOutput, getErr := getCmd.CombinedOutput()
		logCommandResult(getCmd, getErr, getOutput)
		if getErr != nil {
			debugLog(2, "Failed to add module dependency: %v", getErr)

			// Try to add the module root if adding the specific package failed
			if moduleRoot != pkgPath {
				rootGetCmd := exec.CommandContext(ctx, "go", "get", "-d", moduleRoot)
				rootGetCmd.Dir = tempDir
				logCommand(rootGetCmd)

				rootOutput, rootErr := rootGetCmd.CombinedOutput()
				logCommandResult(rootGetCmd, rootErr, rootOutput)
				if rootErr != nil {
					debugLog(2, "Failed to add module root dependency: %v", rootErr)
				} else {
					debugLog(2, "Successfully added module root dependency: %s", moduleRoot)
				}
			}
		} else {
			debugLog(2, "Successfully added module dependency: %s", pkgPath)
		}

		// Run go mod tidy with -e flag to ignore errors
		tidyCmd := exec.CommandContext(ctx, "go", "mod", "tidy", "-e")
		tidyCmd.Dir = tempDir
		logCommand(tidyCmd)

		tidyOutput, tidyErr := tidyCmd.CombinedOutput()
		logCommandResult(tidyCmd, tidyErr, tidyOutput)
		if tidyErr != nil {
			debugLog(2, "go mod tidy failed: %v", tidyErr)
		} else {
			debugLog(2, "Successfully tidied module dependencies")
		}

		// Now try to use the Go module to extract information
		debugLog(2, "Trying to extract information using go list with JSON output")

		// Try downloading the package after it's been properly added to go.mod
		// First build the module to ensure it's fully downloaded
		buildCmd := exec.CommandContext(ctx, "go", "build", "-o", "/dev/null", ".")
		buildCmd.Dir = tempDir
		logCommand(buildCmd)

		// Ignore build errors, we're just trying to force module download
		buildOutput, buildErr := buildCmd.CombinedOutput()
		logCommandResult(buildCmd, buildErr, buildOutput)

		// Now try to get the package info
		cmd = exec.CommandContext(ctx, "go", "list", "-json", "-m", "all")
		cmd.Dir = tempDir
		logCommand(cmd)

		modOutput, modErr := cmd.CombinedOutput()
		logCommandResult(cmd, modErr, modOutput)
		if modErr == nil && *verbosityLevel >= 3 {
			debugLog(3, "Module list sample: %s", truncateOutput(string(modOutput), 500))
		}

		// Try to get package documentation which is often more reliable
		docCmd := exec.CommandContext(ctx, "go", "doc", "-all", pkgPath)
		docCmd.Dir = tempDir
		logCommand(docCmd)

		docOutput, docErr := docCmd.CombinedOutput()
		logCommandResult(docCmd, docErr, docOutput)
		var result *PackageSymbols

		if docErr == nil {
			debugLog(1, "Successfully got docs, size: %d bytes", len(docOutput))
			// We got some documentation, try to extract symbols from it
			result = createMinimalPackageSymbols(pkgPath)
			parseDocOutput(string(docOutput), result)

			// If we found symbols, return the result
			if len(result.Functions) > 0 || len(result.Types) > 0 || len(result.Variables) > 0 {
				debugLog(1, "Extracted %d functions, %d types, %d variables from %s using docs",
					len(result.Functions), len(result.Types), len(result.Variables), pkgPath)
				return result, nil
			}
		} else {
			debugLog(2, "Failed to get docs: %v", docErr)
		}

		// Final attempt - try with go list with modules
		cmd = exec.CommandContext(ctx, "go", "list", "-json", pkgPath)
		cmd.Dir = tempDir
		logCommand(cmd)

		output, err = cmd.CombinedOutput()
		logCommandResult(cmd, err, output)
		if err != nil {
			debugLog(2, "Failed to list package: %v", err)

			// If we already have some info from docs, use that
			if result != nil && (len(result.Functions) > 0 || len(result.Types) > 0 || len(result.Variables) > 0) {
				return result, nil
			}

			// Return a minimal package structure with the name
			return createMinimalPackageSymbols(pkgPath), fmt.Errorf("failed to get package information: %v", err)
		}

		// If we got here, we have JSON output to parse
		var pkgInfo struct {
			Name    string   `json:"Name"`
			PkgPath string   `json:"ImportPath"`
			Exports []string `json:"Exports"`
		}

		if err := json.Unmarshal(output, &pkgInfo); err != nil {
			fmt.Fprintf(os.Stderr, "DEBUG: Failed to parse JSON: %v\n", err)

			// If we already have some info from docs, use that
			if result != nil && (len(result.Functions) > 0 || len(result.Types) > 0 || len(result.Variables) > 0) {
				return result, nil
			}

			return createMinimalPackageSymbols(pkgPath), fmt.Errorf("failed to parse package info: %v", err)
		}

		// Create package symbols from the JSON output
		result = &PackageSymbols{
			Name:       pkgInfo.Name,
			ImportPath: pkgInfo.PkgPath,
			Functions:  []Function{},
			Types:      []Type{},
			Variables:  []Variable{},
		}

		// Process exported symbols
		for _, symbolName := range pkgInfo.Exports {
			processExportedSymbol(symbolName, result)
		}

		// Use godoc for additional information
		if docErr == nil {
			parseDocOutput(string(docOutput), result)
		}

		fmt.Fprintf(os.Stderr, "DEBUG: Extracted %d functions, %d types, %d variables from %s using list\n",
			len(result.Functions), len(result.Types), len(result.Variables), pkgPath)

		return result, nil
	}

	// For standard library packages, use the direct approach
	var jsonOutput []byte
	var jsonErr error

	cmd := exec.CommandContext(ctx, "go", "list", "-json", pkgPath)
	jsonOutput, jsonErr = cmd.CombinedOutput()
	if jsonErr != nil {
		fmt.Fprintf(os.Stderr, "DEBUG: Command failed: %v\n", jsonErr)
		if verbose {
			fmt.Fprintf(os.Stderr, "DEBUG: Command output: %s\n", string(jsonOutput))
		}

		// Fall back to go doc for standard library
		docCmd := exec.CommandContext(ctx, "go", "doc", "-all", pkgPath)
		docCmd.Dir = tempDir
		logCommand(docCmd)

		docOutput, docErr := docCmd.CombinedOutput()
		if docErr == nil {
			// We were able to get docs, create symbols from that
			result := createMinimalPackageSymbols(pkgPath)
			parseDocOutput(string(docOutput), result)
			return result, nil
		}

		// Return a minimal package structure with the name
		return createMinimalPackageSymbols(pkgPath), fmt.Errorf("failed to run go list: %v - %s", jsonErr, jsonOutput)
	}

	if verbose {
		fmt.Fprintf(os.Stderr, "DEBUG: Command succeeded with output: %s\n", string(jsonOutput))
	}

	// Parse JSON output
	var pkgInfo struct {
		Name    string   `json:"Name"`
		PkgPath string   `json:"ImportPath"`
		Exports []string `json:"Exports"`
	}
	if err := json.Unmarshal(jsonOutput, &pkgInfo); err != nil {
		fmt.Fprintf(os.Stderr, "DEBUG: Failed to parse JSON: %v\n", err)
		return createMinimalPackageSymbols(pkgPath), fmt.Errorf("failed to parse package info: %v", err)
	}

	// If we got here but don't have a package name, use the minimal one
	if pkgInfo.Name == "" {
		fmt.Fprintf(os.Stderr, "DEBUG: Package %s has empty name in response\n", pkgPath)
		return createMinimalPackageSymbols(pkgPath), nil
	}

	// Create package symbols
	result := &PackageSymbols{
		Name:       pkgInfo.Name,
		ImportPath: pkgInfo.PkgPath,
		Functions:  []Function{},
		Types:      []Type{},
		Variables:  []Variable{},
	}

	fmt.Fprintf(os.Stderr, "DEBUG: Found %d exported symbols in package %s\n",
		len(pkgInfo.Exports), pkgPath)

	// Process exported symbols
	for _, symbolName := range pkgInfo.Exports {
		processExportedSymbol(symbolName, result)
	}

	// Use godoc for better information about the package
	cmdDoc := exec.CommandContext(ctx, "go", "doc", "-all", pkgPath)
	cmdDoc.Dir = tempDir
	logCommand(cmdDoc)

	docOutput, err := cmdDoc.CombinedOutput()
	if err != nil {
		fmt.Fprintf(os.Stderr, "DEBUG: go doc command failed: %v\n", err)
		// Continue anyway, we still have basic symbol information
	} else if verbose {
		fmt.Fprintf(os.Stderr, "DEBUG: go doc succeeded with %d bytes of output\n", len(docOutput))
	}

	if err == nil {
		// Parse the output to extract more detailed information
		parseDocOutput(string(docOutput), result)
	}

	fmt.Fprintf(os.Stderr, "DEBUG: Extracted %d functions, %d types, %d variables from %s\n",
		len(result.Functions), len(result.Types), len(result.Variables), pkgPath)

	return result, nil
}

// processExportedSymbol processes an exported symbol name and adds it to the package symbols
func processExportedSymbol(symbolName string, pkg *PackageSymbols) {
	// Skip if the symbol is not exported (doesn't start with an uppercase letter)
	if len(symbolName) == 0 || !unicode.IsUpper(rune(symbolName[0])) {
		return
	}

	// For now, we don't have enough information to distinguish between types and functions
	// So we just add it as a type with "unknown" kind
	pkg.Types = append(pkg.Types, Type{
		Name:       symbolName,
		Kind:       "unknown",
		IsExported: true,
	})
}

// parseDocOutput parses go doc output and extracts symbols
func parseDocOutput(docOutput string, pkg *PackageSymbols) {
	debugLog(1, "Parsing go doc output for package %s", pkg.Name)

	if len(docOutput) == 0 {
		debugLog(1, "Empty doc output for package %s", pkg.Name)
		return
	}

	// Extract package name from the first line
	lines := strings.Split(docOutput, "\n")
	if len(lines) > 0 && strings.HasPrefix(lines[0], "package ") {
		pkg.Name = strings.TrimSpace(strings.TrimPrefix(lines[0], "package "))
		debugLog(1, "Found package name: %s", pkg.Name)
	}

	// Use regex to extract types, functions, methods, constants, and variables
	processedSymbols := 0

	// Match type declarations
	typeRegex := regexp.MustCompile(`(?m)^type ([A-Z]\w+)`)
	typeMatches := typeRegex.FindAllStringSubmatch(docOutput, -1)
	for _, match := range typeMatches {
		if len(match) >= 2 {
			typeName := match[1]
			pkg.Types = append(pkg.Types, Type{
				Name:       typeName,
				IsExported: isTitleCase(typeName),
			})
			debugLog(1, "Found type: %s.%s (isExported: %v)", pkg.ImportPath, typeName, isTitleCase(typeName))
			processedSymbols++
		}
	}

	// Match function declarations
	funcRegex := regexp.MustCompile(`(?m)^func ([A-Z]\w+)(\([^)]*\))?`)
	funcMatches := funcRegex.FindAllStringSubmatch(docOutput, -1)
	for _, match := range funcMatches {
		if len(match) >= 2 {
			funcName := match[1]
			signature := ""
			if len(match) >= 3 && match[2] != "" {
				signature = match[2]
			}
			pkg.Functions = append(pkg.Functions, Function{
				Name:       funcName,
				Signature:  signature,
				IsExported: isTitleCase(funcName),
			})
			debugLog(1, "Found function: %s.%s (isExported: %v)", pkg.ImportPath, funcName, isTitleCase(funcName))
			processedSymbols++
		}
	}

	// Match method declarations
	methodRegex := regexp.MustCompile(`(?m)^func \((\w+ [*]?\w+)\) ([A-Z]\w+)(\([^)]*\))?`)
	methodMatches := methodRegex.FindAllStringSubmatch(docOutput, -1)
	for _, match := range methodMatches {
		if len(match) >= 3 {
			methodName := match[2]
			signature := match[1]
			if len(match) >= 4 && match[3] != "" {
				signature += " " + match[3]
			}
			pkg.Functions = append(pkg.Functions, Function{
				Name:       methodName,
				Signature:  signature,
				IsExported: isTitleCase(methodName),
			})
			debugLog(1, "Found method: %s.%s (isExported: %v)", pkg.ImportPath, methodName, isTitleCase(methodName))
			processedSymbols++
		}
	}

	// Match variable and constant declarations
	varRegex := regexp.MustCompile(`(?m)^var ([A-Z]\w+)`)
	varMatches := varRegex.FindAllStringSubmatch(docOutput, -1)
	for _, match := range varMatches {
		if len(match) >= 2 {
			varName := match[1]
			pkg.Variables = append(pkg.Variables, Variable{
				Name:       varName,
				IsConstant: false,
				IsExported: isTitleCase(varName),
			})
			debugLog(1, "Found variable: %s.%s (isExported: %v)", pkg.ImportPath, varName, isTitleCase(varName))
			processedSymbols++
		}
	}

	// Match constants
	constRegex := regexp.MustCompile(`(?m)^const ([A-Z]\w+)`)
	constMatches := constRegex.FindAllStringSubmatch(docOutput, -1)
	for _, match := range constMatches {
		if len(match) >= 2 {
			constName := match[1]
			pkg.Variables = append(pkg.Variables, Variable{
				Name:       constName,
				IsConstant: true,
				IsExported: isTitleCase(constName),
			})
			debugLog(1, "Found constant: %s.%s (isExported: %v)", pkg.ImportPath, constName, isTitleCase(constName))
			processedSymbols++
		}
	}

	debugLog(1, "Total symbols processed: %d for package %s", processedSymbols, pkg.ImportPath)
}

// isTitleCase checks if a string starts with an uppercase letter
func isTitleCase(s string) bool {
	if len(s) == 0 {
		return false
	}
	return unicode.IsUpper(rune(s[0]))
}

// truncateOutput truncates a string output to a maximum length with ellipsis
func truncateOutput(output string, maxLength int) string {
	if len(output) <= maxLength {
		return output
	}
	return output[:maxLength] + "... (truncated)"
}
