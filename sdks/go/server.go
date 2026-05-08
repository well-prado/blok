package blok

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// Server is the blok HTTP server that handles execute and health requests.
type Server struct {
	registry   *NodeRegistry
	config     ServerConfig
	httpServer *http.Server
}

// NewServer creates a new blok server.
func NewServer(registry *NodeRegistry, config ServerConfig) *Server {
	return &Server{
		registry: registry,
		config:   config,
	}
}

// Start starts the HTTP server and blocks until it is shut down.
func (s *Server) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/execute", s.handleExecute)
	mux.HandleFunc("/health", s.handleHealth)

	var handler http.Handler = mux
	if s.config.EnableCORS {
		handler = s.corsHandler(handler)
	}

	s.httpServer = &http.Server{
		Addr:         s.config.Address(),
		Handler:      handler,
		ReadTimeout:  time.Duration(s.config.ReadTimeoutSec) * time.Second,
		WriteTimeout: time.Duration(s.config.WriteTimeoutSec) * time.Second,
	}

	log.Printf("Blok runtime v%s starting on %s", s.config.Version, s.config.Address())
	log.Printf("Registered nodes: %v", s.registry.NodeNames())

	return s.httpServer.ListenAndServe()
}

// Shutdown gracefully shuts down the server.
func (s *Server) Shutdown() error {
	if s.httpServer == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(s.config.ShutdownTimeoutSec)*time.Second)
	defer cancel()
	log.Println("Shutting down blok runtime...")
	return s.httpServer.Shutdown(ctx)
}

// HTTPServer returns the underlying http.Server for advanced use cases.
func (s *Server) HTTPServer() *http.Server {
	return s.httpServer
}

func (s *Server) handleExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.writeJSON(w, http.StatusMethodNotAllowed, &ExecutionResult{
			Success: false,
			Errors:  map[string]string{"message": "method not allowed, use POST"},
		})
		return
	}

	var req ExecutionRequest
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&req); err != nil {
		s.writeJSON(w, http.StatusBadRequest, &ExecutionResult{
			Success: false,
			Errors:  map[string]string{"message": fmt.Sprintf("invalid JSON: %v", err)},
		})
		return
	}

	result := s.registry.Execute(&req)
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	health := s.registry.Health(s.config.Version)
	s.writeJSON(w, http.StatusOK, health)
}

func (s *Server) writeJSON(w http.ResponseWriter, statusCode int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("Error encoding JSON response: %v", err)
	}
}

func (s *Server) corsHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// ListenAndServe is a convenience function that creates the configured
// server(s) and serves until shutdown.
//
// Honors `cfg.Transport`:
//   - TransportHTTP (default): HTTP only.
//   - TransportGRPC: gRPC only on cfg.GRPCPort.
//   - TransportBoth: HTTP + gRPC in the same process.
func ListenAndServe(registry *NodeRegistry) error {
	config := LoadConfigFromEnv()
	return ListenAndServeWithConfig(registry, config)
}

// ListenAndServeWithConfig is the same as ListenAndServe but uses the
// provided config. Useful for tests that want to inject a fixed config.
func ListenAndServeWithConfig(registry *NodeRegistry, config ServerConfig) error {
	switch config.Transport {
	case TransportGRPC:
		return runGrpcOnly(registry, config)
	case TransportBoth:
		return runBoth(registry, config)
	case TransportHTTP, "":
		return runHTTPOnly(registry, config)
	default:
		return fmt.Errorf("unknown BLOK_TRANSPORT %q (expected http | grpc | both)", config.Transport)
	}
}

func runHTTPOnly(registry *NodeRegistry, config ServerConfig) error {
	server := NewServer(registry, config)

	shutdownCh := SetupGracefulShutdown(func() {
		if err := server.Shutdown(); err != nil {
			log.Printf("Error during shutdown: %v", err)
		}
	})

	err := server.Start()
	if err == http.ErrServerClosed {
		<-shutdownCh
		return nil
	}
	return err
}

func runGrpcOnly(registry *NodeRegistry, config ServerConfig) error {
	grpcServer, _, err := StartGrpc(registry, config.Host, config.GRPCPort, GrpcServerOptions{
		SdkVersion: config.Version,
	})
	if err != nil {
		return err
	}

	shutdownCh := SetupGracefulShutdown(func() {
		log.Println("Shutting down gRPC server…")
		grpcServer.GracefulStop()
	})
	<-shutdownCh
	return nil
}

func runBoth(registry *NodeRegistry, config ServerConfig) error {
	grpcServer, _, err := StartGrpc(registry, config.Host, config.GRPCPort, GrpcServerOptions{
		SdkVersion: config.Version,
	})
	if err != nil {
		return err
	}

	httpServer := NewServer(registry, config)

	shutdownCh := SetupGracefulShutdown(func() {
		log.Println("Shutting down gRPC server…")
		grpcServer.GracefulStop()
		if shutErr := httpServer.Shutdown(); shutErr != nil {
			log.Printf("Error during HTTP shutdown: %v", shutErr)
		}
	})

	startErr := httpServer.Start()
	if startErr == http.ErrServerClosed {
		<-shutdownCh
		return nil
	}
	return startErr
}
