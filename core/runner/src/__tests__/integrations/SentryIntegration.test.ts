import { describe, expect, it, vi } from "vitest";
import { type SentryClient, SentryIntegration } from "../../integrations/SentryIntegration";

// Mock Sentry client for testing
function createMockClient(): SentryClient & { events: Array<{ type: string; data: unknown }> } {
	const events: Array<{ type: string; data: unknown }> = [];
	let eventCounter = 0;

	return {
		events,
		captureException: (error: Error, context?: Record<string, unknown>) => {
			const id = `event-${++eventCounter}`;
			events.push({ type: "exception", data: { error: error.message, context, id } });
			return id;
		},
		captureMessage: (message: string, level: string) => {
			const id = `event-${++eventCounter}`;
			events.push({ type: "message", data: { message, level, id } });
			return id;
		},
		setTag: vi.fn(),
		setUser: vi.fn(),
		startTransaction: vi.fn().mockReturnValue({
			setTag: vi.fn(),
			setData: vi.fn(),
			finish: vi.fn(),
			startChild: vi.fn().mockReturnValue({
				setTag: vi.fn(),
				setData: vi.fn(),
				setStatus: vi.fn(),
				finish: vi.fn(),
			}),
		}),
		flush: vi.fn().mockResolvedValue(true),
	};
}

describe("SentryIntegration", () => {
	it("should initialize with config", () => {
		const sentry = new SentryIntegration({
			dsn: "https://test@sentry.io/123",
		});

		expect(sentry.isInitialized()).toBe(false);
		expect(sentry.getStats().eventCount).toBe(0);
	});

	it("should accept custom client", () => {
		const sentry = new SentryIntegration({
			dsn: "https://test@sentry.io/123",
		});

		const mockClient = createMockClient();
		sentry.setClient(mockClient);

		expect(sentry.isInitialized()).toBe(true);
	});

	it("should capture workflow errors", () => {
		const sentry = new SentryIntegration({ dsn: "test" });
		const mockClient = createMockClient();
		sentry.setClient(mockClient);

		const error = new Error("Workflow failed");
		const eventId = sentry.captureWorkflowError(error, {
			workflowName: "create-user",
			workflowPath: "/users/create",
			workflowVersion: "1.0.0",
			requestId: "req-123",
			nodeName: "validate-input",
			nodeType: "module",
			triggerType: "http",
			durationMs: 500,
		});

		expect(eventId).toBeTruthy();
		expect(mockClient.events.length).toBe(1);
		expect(mockClient.events[0].type).toBe("exception");

		const stats = sentry.getStats();
		expect(stats.eventCount).toBe(1);
		expect(stats.errorCount).toBe(1);
	});

	it("should capture node errors", () => {
		const sentry = new SentryIntegration({ dsn: "test" });
		const mockClient = createMockClient();
		sentry.setClient(mockClient);

		const error = new Error("Node timeout");
		const eventId = sentry.captureNodeError(error, "api-call", "module", {
			workflowName: "get-data",
			requestId: "req-456",
		});

		expect(eventId).toBeTruthy();
		expect(mockClient.events.length).toBe(1);
	});

	it("should capture trigger errors", () => {
		const sentry = new SentryIntegration({ dsn: "test" });
		const mockClient = createMockClient();
		sentry.setClient(mockClient);

		const error = new Error("Connection refused");
		const eventId = sentry.captureTriggerError(error, "queue", {
			provider: "kafka",
			topic: "events",
		});

		expect(eventId).toBeTruthy();
		expect(mockClient.events.length).toBe(1);
	});

	it("should capture warnings", () => {
		const sentry = new SentryIntegration({ dsn: "test" });
		const mockClient = createMockClient();
		sentry.setClient(mockClient);

		const eventId = sentry.captureWarning("High memory usage", {
			memoryMb: 512,
		});

		expect(eventId).toBeTruthy();
		expect(mockClient.events[0].type).toBe("message");
		expect(sentry.getStats().eventCount).toBe(1);
		// Warnings don't increment errorCount
		expect(sentry.getStats().errorCount).toBe(0);
	});

	it("should set user context", () => {
		const sentry = new SentryIntegration({ dsn: "test" });
		const mockClient = createMockClient();
		sentry.setClient(mockClient);

		sentry.setUser({ id: "user-123", email: "test@example.com" });

		expect(mockClient.setUser).toHaveBeenCalledWith({
			id: "user-123",
			email: "test@example.com",
		});
	});

	it("should set tags", () => {
		const sentry = new SentryIntegration({ dsn: "test" });
		const mockClient = createMockClient();
		sentry.setClient(mockClient);

		sentry.setTag("environment", "staging");

		expect(mockClient.setTag).toHaveBeenCalledWith("environment", "staging");
	});

	it("should flush pending events", async () => {
		const sentry = new SentryIntegration({ dsn: "test" });
		const mockClient = createMockClient();
		sentry.setClient(mockClient);

		const result = await sentry.flush(5000);
		expect(result).toBe(true);
		expect(mockClient.flush).toHaveBeenCalledWith(5000);
	});

	it("should return null when not initialized", () => {
		const sentry = new SentryIntegration({ dsn: "test" });

		const result = sentry.captureWorkflowError(new Error("test"), {
			workflowName: "x",
			workflowPath: "/x",
		});

		expect(result).toBeNull();
	});

	it("should track stats accurately", () => {
		const sentry = new SentryIntegration({ dsn: "test" });
		const mockClient = createMockClient();
		sentry.setClient(mockClient);

		sentry.captureWorkflowError(new Error("e1"), { workflowName: "a", workflowPath: "/a" });
		sentry.captureNodeError(new Error("e2"), "node", "module");
		sentry.captureTriggerError(new Error("e3"), "http");
		sentry.captureWarning("warn");

		const stats = sentry.getStats();
		expect(stats.eventCount).toBe(4);
		expect(stats.errorCount).toBe(3); // Warnings don't count as errors
		expect(stats.initialized).toBe(true);
	});

	it("should flush without client", async () => {
		const sentry = new SentryIntegration({ dsn: "test" });

		// Should not throw
		const result = await sentry.flush();
		expect(result).toBe(true);
	});

	it("should clear user context", () => {
		const sentry = new SentryIntegration({ dsn: "test" });
		const mockClient = createMockClient();
		sentry.setClient(mockClient);

		sentry.setUser(null);
		expect(mockClient.setUser).toHaveBeenCalledWith(null);
	});
});
