package main

import (
	"fmt"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func main() {
	// This is where we will test completions
	// The symbol should suggest 'NewForConfig' after typing 'kubernetes.'
	config := &rest.Config{}
	clientset, err := kubernetes.NewForConfig(config)

	fmt.Println(clientset, err)
}
