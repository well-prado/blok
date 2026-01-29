package nanoservice

import (
	"log"
	"os"
	"os/signal"
	"syscall"
)

// SetupGracefulShutdown registers signal handlers for SIGINT and SIGTERM
// and calls the provided cleanup function when a signal is received.
//
// Returns a channel that is closed after cleanup completes.
func SetupGracefulShutdown(cleanup func()) <-chan struct{} {
	done := make(chan struct{})

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigCh
		log.Printf("Received signal: %v", sig)

		if cleanup != nil {
			cleanup()
		}

		close(done)
	}()

	return done
}
