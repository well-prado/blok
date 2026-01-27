package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/deskree-inc/blok/examples/runtimes/go/sdk"
	helloworld "github.com/deskree-inc/blok/examples/runtimes/go/nodes/hello-world"
)

const VERSION = "1.0.0"

var registry *blok.NodeRegistry

func main() {
	// Initialize node registry
	registry = blok.NewNodeRegistry()

	// Register nodes
	registry.Register("hello-world", helloworld.GetNodeHandler())
	// Add more nodes here as needed
	// registry.Register("another-node", anothernode.GetNodeHandler())

	// Setup HTTP server
	http.HandleFunc("/execute", executeHandler)
	http.HandleFunc("/health", healthHandler)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Blok Go Runtime v%s starting on port %s", VERSION, port)
	log.Printf("Registered nodes: %d", len(registry.GetHealth(VERSION).NodesLoaded))

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

// executeHandler handles node execution requests
func executeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse request
	var req blok.ExecutionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendErrorResponse(w, "Invalid request body", err)
		return
	}

	// Execute node
	result := registry.Execute(&req)

	// Send response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("Error encoding response: %v", err)
	}
}

// healthHandler handles health check requests
func healthHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	health := registry.GetHealth(VERSION)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(health); err != nil {
		log.Printf("Error encoding health response: %v", err)
	}
}

// sendErrorResponse sends an error response
func sendErrorResponse(w http.ResponseWriter, message string, err error) {
	result := &blok.ExecutionResult{
		Success: false,
		Data:    nil,
		Errors: map[string]string{
			"message": message,
			"error":   err.Error(),
		},
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	json.NewEncoder(w).Encode(result)
}
