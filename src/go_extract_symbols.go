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
)

// Output structure
type SymbolOutput struct {
	Packages []PackageSymbols `json:"Packages"`
}

// Package symbols
type PackageSymbols struct {
	Name       string     `json:"Name"`
	ImportPath string     `json:"ImportPath"`
	Functions  []Function `json:"Functions"`
	Types      []Type     `json:"Types"`
	Variables  []Variable `json:"Variables"`
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
)

// logCommand logs command execution details to stderr
func logCommand(cmd *exec.Cmd) {
	if *verbose || *debug {
		fmt.Fprintf(os.Stderr, "DEBUG: Executing command: %s\n", cmd.Path)
		fmt.Fprintf(os.Stderr, "DEBUG: Working directory: %s\n", cmd.Dir)
	}
}

// debugLog logs messages only when debug mode is enabled
func debugLog(format string, args ...interface{}) {
	if *debug {
		fmt.Fprintf(os.Stderr, "DEBUG: "+format+"\n", args...)
	}
}

// verboseLog logs messages only when verbose mode is enabled
func verboseLog(format string, args ...interface{}) {
	if *verbose || *debug {
		fmt.Fprintf(os.Stderr, "DEBUG: "+format+"\n", args...)
	}
}

func main() {
	// Parse command line flags
	flag.Parse()

	if *packagesFile == "" {
		fmt.Fprintf(os.Stderr, "Error: -packages flag is required\n")
		os.Exit(1)
	}

	// Log startup info
	fmt.Fprintf(os.Stderr, "DEBUG: Starting Go symbol extraction\n")
	fmt.Fprintf(os.Stderr, "DEBUG: Packages file: %s\n", *packagesFile)
	fmt.Fprintf(os.Stderr, "DEBUG: Current working directory: %s\n", getWorkingDir())

	// Ensure GO111MODULE is set to on for consistent behavior
	os.Setenv("GO111MODULE", "on")
	fmt.Fprintf(os.Stderr, "DEBUG: Set GO111MODULE=on\n")

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

	fmt.Fprintf(os.Stderr, "DEBUG: Found %d packages to analyze\n", len(packages))
	if *verbose {
		fmt.Fprintf(os.Stderr, "DEBUG: Packages to analyze: %s\n", strings.Join(packages, ", "))
	}

	// Create temp directory for our module
	tempDir, err := ioutil.TempDir("", "go-symbols-extractor")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating temp directory: %v\n", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tempDir)

	fmt.Fprintf(os.Stderr, "DEBUG: Created temporary directory: %s\n", tempDir)

	// Initialize a Go module with a higher Go version to support more modules
	goModContent := `module symbols-extractor

go 1.21
`

	err = ioutil.WriteFile(filepath.Join(tempDir, "go.mod"), []byte(goModContent), 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating go.mod file: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "DEBUG: Created go.mod in %s\n", tempDir)

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
	fmt.Fprintf(os.Stderr, "DEBUG: Created main.go in %s\n", tempDir)

	// Verify the module setup
	cmd := exec.Command("go", "mod", "tidy")
	cmd.Dir = tempDir
	logCommand(cmd)
	if err := cmd.Run(); err != nil {
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

	fmt.Fprintf(os.Stderr, "DEBUG: Found %d standard library packages and %d external packages\n",
		len(stdLibPackages), len(externalPackages))

	// First process standard library which doesn't need module setup
	for _, pkgPath := range stdLibPackages {
		fmt.Fprintf(os.Stderr, "DEBUG: Processing standard library package: %s\n", pkgPath)
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
		fmt.Fprintf(os.Stderr, "DEBUG: Processing batch %d to %d of external packages\n", i, end-1)

		for _, pkgPath := range batch {
			fmt.Fprintf(os.Stderr, "DEBUG: Processing external package: %s\n", pkgPath)

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

		if initOutput, initErr := initCmd.CombinedOutput(); initErr != nil {
			fmt.Fprintf(os.Stderr, "DEBUG: Failed to initialize module: %v - %s\n", initErr, string(initOutput))
		} else {
			fmt.Fprintf(os.Stderr, "DEBUG: Successfully initialized new module\n")
		}

		// Create an empty go.sum file
		goSumPath := filepath.Join(tempDir, "go.sum")
		if _, err := os.Stat(goSumPath); os.IsNotExist(err) {
			if err := ioutil.WriteFile(goSumPath, []byte{}, 0644); err != nil {
				fmt.Fprintf(os.Stderr, "DEBUG: Failed to create empty go.sum: %v\n", err)
			} else {
				fmt.Fprintf(os.Stderr, "DEBUG: Created empty go.sum file\n")
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
			fmt.Fprintf(os.Stderr, "DEBUG: Failed to create main.go: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "DEBUG: Created main.go with import for %s\n", pkgPath)
		}

		// Try download with mod download - ignoring errors since we'll verify later
		dlCmd := exec.CommandContext(ctx, "go", "mod", "download", "-x")
		dlCmd.Dir = tempDir
		logCommand(dlCmd)

		if dlOutput, dlErr := dlCmd.CombinedOutput(); dlErr != nil {
			fmt.Fprintf(os.Stderr, "DEBUG: mod download warning (continuing): %v - %s\n", dlErr, string(dlOutput))
		} else {
			fmt.Fprintf(os.Stderr, "DEBUG: Successfully downloaded modules\n")
		}

		// Add the specific module as a requirement using go get
		// This is the most important step - directly add the package
		getCmd := exec.CommandContext(ctx, "go", "get", "-d", pkgPath)
		getCmd.Dir = tempDir
		logCommand(getCmd)

		if getOutput, getErr := getCmd.CombinedOutput(); getErr != nil {
			fmt.Fprintf(os.Stderr, "DEBUG: Failed to add module dependency: %v - %s\n", getErr, string(getOutput))

			// Try to add the module root if adding the specific package failed
			if moduleRoot != pkgPath {
				rootGetCmd := exec.CommandContext(ctx, "go", "get", "-d", moduleRoot)
				rootGetCmd.Dir = tempDir
				logCommand(rootGetCmd)

				if rootOutput, rootErr := rootGetCmd.CombinedOutput(); rootErr != nil {
					fmt.Fprintf(os.Stderr, "DEBUG: Failed to add module root dependency: %v - %s\n", rootErr, string(rootOutput))
				} else {
					fmt.Fprintf(os.Stderr, "DEBUG: Successfully added module root dependency: %s\n", moduleRoot)
				}
			}
		} else {
			fmt.Fprintf(os.Stderr, "DEBUG: Successfully added module dependency: %s\n", pkgPath)
		}

		// Run go mod tidy with -e flag to ignore errors
		tidyCmd := exec.CommandContext(ctx, "go", "mod", "tidy", "-e")
		tidyCmd.Dir = tempDir
		logCommand(tidyCmd)

		if tidyOutput, tidyErr := tidyCmd.CombinedOutput(); tidyErr != nil {
			fmt.Fprintf(os.Stderr, "DEBUG: go mod tidy failed: %v - %s\n", tidyErr, string(tidyOutput))
		} else {
			fmt.Fprintf(os.Stderr, "DEBUG: Successfully tidied module dependencies\n")
		}

		// Now try to use the Go module to extract information
		fmt.Fprintf(os.Stderr, "DEBUG: Trying to extract information using go list with JSON output\n")

		// Try downloading the package after it's been properly added to go.mod
		// First build the module to ensure it's fully downloaded
		buildCmd := exec.CommandContext(ctx, "go", "build", "-o", "/dev/null", ".")
		buildCmd.Dir = tempDir
		logCommand(buildCmd)

		// Ignore build errors, we're just trying to force module download
		buildCmd.CombinedOutput()

		// Now try to get the package info
		cmd = exec.CommandContext(ctx, "go", "list", "-json", "-m", "all")
		cmd.Dir = tempDir
		logCommand(cmd)

		modOutput, modErr := cmd.CombinedOutput()
		if modErr == nil && verbose {
			fmt.Fprintf(os.Stderr, "DEBUG: Module list: %s\n", string(modOutput))
		}

		// Try to get package documentation which is often more reliable
		docCmd := exec.CommandContext(ctx, "go", "doc", "-all", pkgPath)
		docCmd.Dir = tempDir
		logCommand(docCmd)

		docOutput, docErr := docCmd.CombinedOutput()
		var result *PackageSymbols

		if docErr == nil {
			fmt.Fprintf(os.Stderr, "DEBUG: Successfully got docs, size: %d bytes\n", len(docOutput))
			// We got some documentation, try to extract symbols from it
			result = createMinimalPackageSymbols(pkgPath)
			parseDocOutput(string(docOutput), result)

			// If we found symbols, return the result
			if len(result.Functions) > 0 || len(result.Types) > 0 || len(result.Variables) > 0 {
				fmt.Fprintf(os.Stderr, "DEBUG: Extracted %d functions, %d types, %d variables from %s using docs\n",
					len(result.Functions), len(result.Types), len(result.Variables), pkgPath)
				return result, nil
			}
		} else {
			fmt.Fprintf(os.Stderr, "DEBUG: Failed to get docs: %v\n", docErr)
		}

		// Final attempt - try with go list with modules
		cmd = exec.CommandContext(ctx, "go", "list", "-json", pkgPath)
		cmd.Dir = tempDir
		logCommand(cmd)

		output, err = cmd.CombinedOutput()
		if err != nil {
			fmt.Fprintf(os.Stderr, "DEBUG: Failed to list package: %v\n", err)

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

// processExportedSymbol adds a symbol to the package based on name
func processExportedSymbol(symbolName string, pkg *PackageSymbols) {
	if symbolName == "" {
		return
	}

	debugLog("Processing exported symbol: %s in package %s", symbolName, pkg.ImportPath)

	// Check if symbol starts with uppercase letter (exported)
	firstChar := symbolName[0:1]
	isExported := firstChar == strings.ToUpper(firstChar) && firstChar != strings.ToLower(firstChar)

	// Debug info about export status
	if *debug {
		if isExported {
			debugLog("Symbol %s.%s is exported (first char: %s)", pkg.ImportPath, symbolName, firstChar)
		} else {
			debugLog("Symbol %s.%s is NOT exported (first char: %s) - will be skipped", pkg.ImportPath, symbolName, firstChar)
		}
	}

	if !isExported {
		// Skip non-exported symbols
		return
	}

	// Try to guess the symbol type based on naming conventions
	if strings.HasPrefix(symbolName, "New") || strings.HasPrefix(symbolName, "Create") ||
		strings.HasSuffix(symbolName, "Func") || strings.HasSuffix(symbolName, "Function") {
		// Likely a function
		pkg.Functions = append(pkg.Functions, Function{
			Name:       symbolName,
			IsExported: true,
		})
		debugLog("Added symbol %s.%s as a function", pkg.ImportPath, symbolName)
	} else if isTitleCase(symbolName) && !strings.HasSuffix(symbolName, "s") &&
		!strings.HasSuffix(symbolName, "er") && symbolName != pkg.Name {
		// Likely a type (CamelCase, not plural, not ending with -er, not same as package name)
		pkg.Types = append(pkg.Types, Type{
			Name:       symbolName,
			IsExported: true,
		})
		debugLog("Added symbol %s.%s as a type", pkg.ImportPath, symbolName)
	} else {
		// Default to variable
		pkg.Variables = append(pkg.Variables, Variable{
			Name:       symbolName,
			IsExported: true,
		})
		debugLog("Added symbol %s.%s as a variable", pkg.ImportPath, symbolName)
	}
}

// parseDocOutput parses go doc output and extracts symbols
func parseDocOutput(docOutput string, pkg *PackageSymbols) {
	debugLog("Parsing go doc output for package %s", pkg.Name)

	if len(docOutput) == 0 {
		debugLog("Empty doc output for package %s", pkg.Name)
		return
	}

	// Extract package name from the first line
	lines := strings.Split(docOutput, "\n")
	if len(lines) > 0 && strings.HasPrefix(lines[0], "package ") {
		pkg.Name = strings.TrimSpace(strings.TrimPrefix(lines[0], "package "))
		debugLog("Found package name: %s", pkg.Name)
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
			debugLog("Found type: %s.%s (isExported: %v)", pkg.ImportPath, typeName, isTitleCase(typeName))
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
			debugLog("Found function: %s.%s (isExported: %v)", pkg.ImportPath, funcName, isTitleCase(funcName))
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
			debugLog("Found method: %s.%s (isExported: %v)", pkg.ImportPath, methodName, isTitleCase(methodName))
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
			debugLog("Found variable: %s.%s (isExported: %v)", pkg.ImportPath, varName, isTitleCase(varName))
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
			debugLog("Found constant: %s.%s (isExported: %v)", pkg.ImportPath, constName, isTitleCase(constName))
			processedSymbols++
		}
	}

	debugLog("Total symbols processed: %d for package %s", processedSymbols, pkg.ImportPath)
}

// isTitleCase checks if a string starts with an uppercase letter
func isTitleCase(s string) bool {
	if s == "" {
		return false
	}
	firstChar := s[0:1]
	return firstChar == strings.ToUpper(firstChar) && firstChar != strings.ToLower(firstChar)
}
