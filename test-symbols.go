package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Symbol structures matching those in go_extract_symbols.go
type SymbolOutput struct {
	Packages []PackageSymbols `json:"Packages"`
}

type PackageSymbols struct {
	Name       string     `json:"Name"`
	ImportPath string     `json:"ImportPath"`
	Functions  []Function `json:"Functions"`
	Types      []Type     `json:"Types"`
	Variables  []Variable `json:"Variables"`
}

type Function struct {
	Name       string `json:"Name"`
	IsExported bool   `json:"IsExported"`
	Signature  string `json:"Signature"`
}

type Type struct {
	Name       string `json:"Name"`
	Kind       string `json:"Kind"`
	IsExported bool   `json:"IsExported"`
}

type Variable struct {
	Name       string `json:"Name"`
	IsExported bool   `json:"IsExported"`
	IsConstant bool   `json:"IsConstant"`
}

// TestFunction demonstrates the issue with "NewForConfig"
func TestFunction() {
	fmt.Println("Testing symbol extraction")
}

func main() {
	// Check if we have k8s installed
	hasK8s := false
	cmd := exec.Command("go", "list", "k8s.io/client-go/kubernetes")
	if err := cmd.Run(); err == nil {
		hasK8s = true
	}

	// Create a test package list file
	tmpFile := "test-packages.txt"

	var contents string
	if hasK8s {
		// Add k8s packages if available
		contents = "os\nnet/http\nk8s.io/client-go/kubernetes\nk8s.io/client-go/tools/clientcmd\n"
		fmt.Println("Kubernetes packages are available, will test with them")
	} else {
		// Fallback to standard library
		contents = "os\nnet/http\nencoding/json\ntime\n"
		fmt.Println("Kubernetes packages are not available, falling back to standard library")
	}

	os.WriteFile(tmpFile, []byte(contents), 0644)

	// Run our helper against standard library packages
	cmd = exec.Command("go", "run", "src/go_extract_symbols.go", "-packages="+tmpFile)
	output, err := cmd.CombinedOutput()
	if err != nil {
		fmt.Printf("Error running command: %v\n", err)
	}

	// Parse the output to analyze the symbols
	var symbolOutput SymbolOutput
	if err := json.Unmarshal(output, &symbolOutput); err != nil {
		fmt.Printf("Error parsing JSON: %v\n", err)
		fmt.Println("First 200 bytes of output:", string(output[:min(200, len(output))]))
		os.Exit(1)
	}

	// Search for "NewForConfig" specifically
	fmt.Println("\nLooking for 'NewForConfig' functions:")
	found := false
	for _, pkg := range symbolOutput.Packages {
		for _, fn := range pkg.Functions {
			if fn.Name == "NewForConfig" {
				found = true
				fmt.Printf("  FOUND! %s.%s%s\n", pkg.Name, fn.Name, fn.Signature)
			} else if strings.Contains(fn.Name, "NewForConfig") {
				fmt.Printf("  PARTIAL MATCH: %s.%s%s\n", pkg.Name, fn.Name, fn.Signature)
			}
		}
	}

	if !found {
		fmt.Println("  No exact matches for 'NewForConfig'")
	}

	// Also search for similar functions
	fmt.Println("\nFunctions starting with 'New':")
	count := 0
	for _, pkg := range symbolOutput.Packages {
		for _, fn := range pkg.Functions {
			if strings.HasPrefix(fn.Name, "New") && count < 30 {
				fmt.Printf("  %s.%s%s\n", pkg.Name, fn.Name, fn.Signature)
				count++
			}
		}
	}

	// Clean up
	os.Remove(tmpFile)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
