package blok

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// WorkerConfig holds the configuration for a NATS JetStream worker.
type WorkerConfig struct {
	// Servers is a list of NATS server URLs (default: ["localhost:4222"]).
	Servers []string

	// StreamName is the JetStream stream name (default: "blok-worker").
	StreamName string

	// Token is the NATS authentication token (optional).
	Token string

	// User is the NATS username (optional).
	User string

	// Pass is the NATS password (optional).
	Pass string

	// Concurrency is the maximum number of concurrent job handlers (default: 1).
	Concurrency int

	// MaxRetries is the maximum number of delivery attempts (default: 3).
	MaxRetries int

	// AckWait is the timeout for job processing before NATS redelivers (default: 30s).
	AckWait time.Duration

	// Queues is the list of queue names to subscribe to.
	Queues []string
}

// DefaultWorkerConfig returns a WorkerConfig with sensible defaults.
func DefaultWorkerConfig() WorkerConfig {
	return WorkerConfig{
		Servers:     []string{"localhost:4222"},
		StreamName:  "blok-worker",
		Concurrency: 1,
		MaxRetries:  3,
		AckWait:     30 * time.Second,
	}
}

// LoadWorkerConfigFromEnv loads worker configuration from environment variables.
//
// Environment variables:
//   - NATS_SERVERS: Comma-separated NATS server URLs (default: localhost:4222)
//   - NATS_TOKEN: Authentication token (optional)
//   - NATS_USER: Username (optional)
//   - NATS_PASS: Password (optional)
//   - NATS_STREAM_NAME: JetStream stream name (default: blok-worker)
//   - WORKER_CONCURRENCY: Max concurrent jobs (default: 1)
//   - WORKER_MAX_RETRIES: Max delivery attempts (default: 3)
//   - WORKER_ACK_WAIT: Job timeout duration (default: 30s)
//   - WORKER_QUEUES: Comma-separated queue names to subscribe to
func LoadWorkerConfigFromEnv() WorkerConfig {
	cfg := DefaultWorkerConfig()

	if v := os.Getenv("NATS_SERVERS"); v != "" {
		cfg.Servers = strings.Split(v, ",")
	}

	if v := os.Getenv("NATS_TOKEN"); v != "" {
		cfg.Token = v
	}

	if v := os.Getenv("NATS_USER"); v != "" {
		cfg.User = v
	}

	if v := os.Getenv("NATS_PASS"); v != "" {
		cfg.Pass = v
	}

	if v := os.Getenv("NATS_STREAM_NAME"); v != "" {
		cfg.StreamName = v
	}

	if v := os.Getenv("WORKER_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.Concurrency = n
		}
	}

	if v := os.Getenv("WORKER_MAX_RETRIES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			cfg.MaxRetries = n
		}
	}

	if v := os.Getenv("WORKER_ACK_WAIT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			cfg.AckWait = d
		}
	}

	if v := os.Getenv("WORKER_QUEUES"); v != "" {
		cfg.Queues = strings.Split(v, ",")
		for i, q := range cfg.Queues {
			cfg.Queues[i] = strings.TrimSpace(q)
		}
	}

	return cfg
}

// JobMessage represents a job received from a NATS worker queue.
type JobMessage struct {
	// ID is the unique job identifier.
	ID string

	// Queue is the queue name this job came from.
	Queue string

	// Data is the raw JSON job payload.
	Data json.RawMessage

	// Headers are the message headers.
	Headers map[string]string

	// Attempt is the current delivery attempt (0-based).
	Attempt int

	// MaxRetries is the maximum number of retries configured.
	MaxRetries int
}

// DataAs unmarshals the job data into the target struct.
func (j *JobMessage) DataAs(target interface{}) error {
	return json.Unmarshal(j.Data, target)
}

// DataMap returns the job data as a map, or nil if not a valid JSON object.
func (j *JobMessage) DataMap() map[string]interface{} {
	var m map[string]interface{}
	if err := json.Unmarshal(j.Data, &m); err != nil {
		return nil
	}
	return m
}

// JobHandler is the function signature for handling jobs.
type JobHandler func(ctx context.Context, job *JobMessage) error

// Worker processes background jobs from NATS JetStream queues.
type Worker struct {
	config   WorkerConfig
	registry *NodeRegistry
	handlers map[string]JobHandler

	nc   *nats.Conn
	js   jetstream.JetStream
	mu   sync.Mutex
	subs []jetstream.ConsumeContext
}

// NewWorker creates a new NATS JetStream worker.
func NewWorker(registry *NodeRegistry, config WorkerConfig) *Worker {
	return &Worker{
		config:   config,
		registry: registry,
		handlers: make(map[string]JobHandler),
	}
}

// Handle registers a custom handler for a queue.
func (w *Worker) Handle(queue string, handler JobHandler) {
	w.handlers[queue] = handler
}

// HandleNode registers a handler that routes jobs to a registered node.
// The job data becomes the node's input context (ctx.request.body).
func (w *Worker) HandleNode(queue, nodeName string) {
	w.handlers[queue] = func(ctx context.Context, job *JobMessage) error {
		// Build an ExecutionRequest matching the SDK's /execute contract
		req := &ExecutionRequest{
			Node: NodeConfig{
				Name:   nodeName,
				Config: job.DataMap(),
			},
			Context: Context{
				ID: job.ID,
				Request: Request{
					Body:    job.DataMap(),
					Headers: job.Headers,
					Params: map[string]string{
						"queue":   job.Queue,
						"jobId":   job.ID,
						"attempt": strconv.Itoa(job.Attempt),
					},
					Query: map[string]string{},
				},
				Vars: map[string]interface{}{
					"_worker_job": map[string]interface{}{
						"id":         job.ID,
						"queue":      job.Queue,
						"attempts":   strconv.Itoa(job.Attempt),
						"maxRetries": strconv.Itoa(job.MaxRetries),
					},
				},
			},
		}

		result := w.registry.Execute(req)
		if !result.Success {
			errMsg := "node execution failed"
			if errs, ok := result.Errors.(map[string]string); ok {
				if msg, ok := errs["message"]; ok {
					errMsg = msg
				}
			}
			return fmt.Errorf("%s", errMsg)
		}

		return nil
	}
}

// Start connects to NATS, ensures streams/consumers, and starts processing jobs.
// It blocks until the context is cancelled.
func (w *Worker) Start(ctx context.Context) error {
	// Build NATS connection options
	opts := []nats.Option{
		nats.Name("blok-worker"),
	}

	if w.config.Token != "" {
		opts = append(opts, nats.Token(w.config.Token))
	}
	if w.config.User != "" && w.config.Pass != "" {
		opts = append(opts, nats.UserInfo(w.config.User, w.config.Pass))
	}

	// Connect to NATS
	nc, err := nats.Connect(strings.Join(w.config.Servers, ","), opts...)
	if err != nil {
		return fmt.Errorf("failed to connect to NATS: %w", err)
	}
	w.nc = nc

	// Create JetStream context
	js, err := jetstream.New(nc)
	if err != nil {
		return fmt.Errorf("failed to create JetStream context: %w", err)
	}
	w.js = js

	log.Printf("[Worker] Connected to NATS: %s", strings.Join(w.config.Servers, ", "))

	// Process each queue
	for queue, handler := range w.handlers {
		if err := w.startQueue(ctx, queue, handler); err != nil {
			return fmt.Errorf("failed to start queue %s: %w", queue, err)
		}
	}

	log.Printf("[Worker] Processing %d queue(s), concurrency=%d", len(w.handlers), w.config.Concurrency)

	// Block until context is done
	<-ctx.Done()

	log.Println("[Worker] Shutting down...")
	return w.Stop()
}

// Stop gracefully stops all consumers and disconnects from NATS.
func (w *Worker) Stop() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Stop all consume contexts
	for _, sub := range w.subs {
		sub.Stop()
	}
	w.subs = nil

	// Drain NATS connection
	if w.nc != nil {
		if err := w.nc.Drain(); err != nil {
			log.Printf("[Worker] Error draining NATS connection: %v", err)
		}
	}

	log.Println("[Worker] Stopped")
	return nil
}

// startQueue ensures stream/consumer exist and starts consuming for one queue.
func (w *Worker) startQueue(ctx context.Context, queue string, handler JobHandler) error {
	subject := fmt.Sprintf("worker.%s", queue)
	streamName := w.config.StreamName

	// Ensure stream exists
	if err := w.ensureStream(ctx, streamName, subject); err != nil {
		return fmt.Errorf("failed to ensure stream: %w", err)
	}

	// Create or update durable consumer
	durableName := fmt.Sprintf("blok-worker-%s", queue)
	_, err := w.js.CreateOrUpdateConsumer(ctx, streamName, jetstream.ConsumerConfig{
		Durable:       durableName,
		AckPolicy:     jetstream.AckExplicitPolicy,
		MaxDeliver:    w.config.MaxRetries + 1, // +1 for initial delivery
		AckWait:       w.config.AckWait + 5*time.Second, // Buffer for processing
		FilterSubject: subject,
	})
	if err != nil {
		return fmt.Errorf("failed to create consumer: %w", err)
	}

	// Get consumer handle
	consumer, err := w.js.Consumer(ctx, streamName, durableName)
	if err != nil {
		return fmt.Errorf("failed to get consumer: %w", err)
	}

	// Use a semaphore for concurrency control
	sem := make(chan struct{}, w.config.Concurrency)

	// Start consuming with callback
	cc, err := consumer.Consume(func(msg jetstream.Msg) {
		sem <- struct{}{} // Acquire semaphore

		go func() {
			defer func() { <-sem }() // Release semaphore

			w.processMessage(ctx, msg, queue, handler)
		}()
	})
	if err != nil {
		return fmt.Errorf("failed to start consumer: %w", err)
	}

	w.mu.Lock()
	w.subs = append(w.subs, cc)
	w.mu.Unlock()

	log.Printf("[Worker] Subscribed to queue: %s (stream=%s, consumer=%s)", queue, streamName, durableName)
	return nil
}

// processMessage handles a single message from NATS.
func (w *Worker) processMessage(ctx context.Context, msg jetstream.Msg, queue string, handler JobHandler) {
	// Extract headers
	headers := make(map[string]string)
	if msg.Headers() != nil {
		for key := range msg.Headers() {
			headers[key] = msg.Headers().Get(key)
		}
	}

	// Extract job metadata
	jobID := headers["x-job-id"]
	if jobID == "" {
		jobID = headers["Nats-Msg-Id"]
	}
	if jobID == "" {
		jobID = fmt.Sprintf("job-%d", time.Now().UnixNano())
	}

	// Get metadata for redelivery count
	meta, err := msg.Metadata()
	attempt := 0
	if err == nil && meta != nil {
		attempt = int(meta.NumDelivered) - 1 // 0-based
		if attempt < 0 {
			attempt = 0
		}
	}

	job := &JobMessage{
		ID:         jobID,
		Queue:      queue,
		Data:       msg.Data(),
		Headers:    headers,
		Attempt:    attempt,
		MaxRetries: w.config.MaxRetries,
	}

	log.Printf("[Worker] Processing job %s from %s (attempt %d/%d)", job.ID, queue, attempt+1, w.config.MaxRetries+1)

	start := time.Now()
	if err := handler(ctx, job); err != nil {
		elapsed := time.Since(start)
		log.Printf("[Worker] Job %s failed after %v: %v", job.ID, elapsed, err)

		// Nak for redelivery (NATS handles max_deliver limit)
		if nakErr := msg.Nak(); nakErr != nil {
			log.Printf("[Worker] Failed to nak message: %v", nakErr)
		}
		return
	}

	elapsed := time.Since(start)
	log.Printf("[Worker] Job %s completed in %v", job.ID, elapsed)

	// Acknowledge successful processing
	if ackErr := msg.Ack(); ackErr != nil {
		log.Printf("[Worker] Failed to ack message: %v", ackErr)
	}
}

// ensureStream creates or updates a JetStream stream.
func (w *Worker) ensureStream(ctx context.Context, name, subject string) error {
	// Try to get existing stream
	stream, err := w.js.Stream(ctx, name)
	if err == nil {
		// Stream exists — check if subject is included
		info, infoErr := stream.Info(ctx)
		if infoErr != nil {
			return infoErr
		}

		subjectExists := false
		for _, s := range info.Config.Subjects {
			if s == subject || s == subject+".*" || s == subject+".>" {
				subjectExists = true
				break
			}
		}

		if !subjectExists {
			// Add the new subject
			newSubjects := append(info.Config.Subjects, subject)
			cfg := info.Config
			cfg.Subjects = newSubjects
			_, updateErr := w.js.UpdateStream(ctx, cfg)
			if updateErr != nil {
				return fmt.Errorf("failed to update stream subjects: %w", updateErr)
			}
		}
		return nil
	}

	// Stream doesn't exist — create it
	_, createErr := w.js.CreateStream(ctx, jetstream.StreamConfig{
		Name:      name,
		Subjects:  []string{"worker.>"},
		Retention: jetstream.WorkQueuePolicy,
		Storage:   jetstream.FileStorage,
	})
	if createErr != nil {
		return fmt.Errorf("failed to create stream: %w", createErr)
	}

	log.Printf("[Worker] Created JetStream stream: %s", name)
	return nil
}

// Dispatch publishes a job to a worker queue.
// This is a convenience method for programmatic job dispatching.
func (w *Worker) Dispatch(ctx context.Context, queue string, data interface{}, opts *DispatchOpts) (string, error) {
	if w.nc == nil || w.js == nil {
		return "", fmt.Errorf("worker not connected, call Start() first")
	}

	subject := fmt.Sprintf("worker.%s", queue)

	// Encode data as JSON
	payload, err := json.Marshal(data)
	if err != nil {
		return "", fmt.Errorf("failed to marshal job data: %w", err)
	}

	// Build message with headers
	msg := nats.NewMsg(subject)
	msg.Data = payload

	jobID := fmt.Sprintf("job-%d", time.Now().UnixNano())
	if opts != nil && opts.JobID != "" {
		jobID = opts.JobID
	}

	msg.Header.Set("x-job-id", jobID)
	msg.Header.Set("Nats-Msg-Id", jobID) // Deduplication

	if opts != nil {
		if opts.Priority > 0 {
			msg.Header.Set("x-priority", strconv.Itoa(opts.Priority))
		}
		if opts.Delay > 0 {
			msg.Header.Set("x-delay", strconv.Itoa(int(opts.Delay.Milliseconds())))
		}
		if opts.Timeout > 0 {
			msg.Header.Set("x-timeout", strconv.Itoa(int(opts.Timeout.Milliseconds())))
		}
	}

	// Publish via JetStream
	_, pubErr := w.js.PublishMsg(ctx, msg)
	if pubErr != nil {
		return "", fmt.Errorf("failed to publish job: %w", pubErr)
	}

	return jobID, nil
}

// DispatchOpts holds optional job dispatch configuration.
type DispatchOpts struct {
	// JobID is an explicit job ID (for deduplication).
	JobID string

	// Priority is the job priority (higher = more important).
	Priority int

	// Delay is the delay before the job should be processed.
	Delay time.Duration

	// Timeout is the processing timeout for this job.
	Timeout time.Duration
}

// ListenAndServeWorker is a convenience function that creates a worker,
// auto-registers all nodes as queue handlers, and starts processing.
// It also starts an HTTP health server in the background.
func ListenAndServeWorker(registry *NodeRegistry) error {
	workerCfg := LoadWorkerConfigFromEnv()
	serverCfg := LoadConfigFromEnv()

	worker := NewWorker(registry, workerCfg)

	// Auto-register all nodes as queue handlers if queues are specified
	if len(workerCfg.Queues) > 0 {
		nodeNames := registry.NodeNames()
		for _, queue := range workerCfg.Queues {
			// If queue name matches a node name, auto-route to that node
			matched := false
			for _, name := range nodeNames {
				if queue == name {
					worker.HandleNode(queue, name)
					matched = true
					break
				}
			}
			// If no match, register a generic handler that routes based on job headers
			if !matched {
				worker.HandleNode(queue, queue)
			}
		}
	}

	// Start HTTP health server in background
	server := NewServer(registry, serverCfg)
	go func() {
		if err := server.Start(); err != nil {
			log.Printf("[Worker] Health server error: %v", err)
		}
	}()

	// Set up graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	shutdownCh := SetupGracefulShutdown(func() {
		cancel()
		if err := server.Shutdown(); err != nil {
			log.Printf("[Worker] Error shutting down health server: %v", err)
		}
	})

	err := worker.Start(ctx)
	<-shutdownCh
	return err
}
