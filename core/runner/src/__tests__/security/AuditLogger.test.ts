import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AuditLogger,
	ConsoleAuditSink,
	InMemoryAuditSink,
	type AuditEntry,
	type AuditSink,
} from "../../security/AuditLogger";

describe("AuditLogger", () => {
	let logger: AuditLogger;

	afterEach(async () => {
		if (logger) {
			await logger.close();
		}
	});

	it("should log auth events", async () => {
		const sink = new InMemoryAuditSink();
		logger = new AuditLogger({ sinks: [sink], bufferSize: 1, flushIntervalMs: 0 });

		logger.logAuth({
			action: "login",
			success: true,
			identity: { sub: "user-123", provider: "jwt" },
			ip: "192.168.1.1",
		});

		await logger.flush();

		const entries = sink.getEntries();
		expect(entries.length).toBe(1);
		expect(entries[0].category).toBe("auth");
		expect(entries[0].action).toBe("login");
		expect(entries[0].success).toBe(true);
		expect(entries[0].actor?.sub).toBe("user-123");
		expect(entries[0].actor?.ip).toBe("192.168.1.1");
		expect(entries[0].severity).toBe("info");
	});

	it("should log failed auth as warning", async () => {
		const sink = new InMemoryAuditSink();
		logger = new AuditLogger({ sinks: [sink], bufferSize: 1, flushIntervalMs: 0 });

		logger.logAuth({
			action: "login",
			success: false,
			error: "Invalid credentials",
		});

		await logger.flush();

		const entries = sink.getEntries();
		expect(entries[0].severity).toBe("warn");
		expect(entries[0].error?.message).toBe("Invalid credentials");
	});

	it("should log authorization events", async () => {
		const sink = new InMemoryAuditSink();
		logger = new AuditLogger({ sinks: [sink], bufferSize: 1, flushIntervalMs: 0 });

		logger.logAuthz({
			action: "execute",
			resource: { type: "workflow", id: "/users/create", name: "create-user" },
			roles: ["developer"],
			allowed: true,
			actor: { sub: "user-123" },
		});

		await logger.flush();

		const entries = sink.getEntries();
		expect(entries[0].category).toBe("authz");
		expect(entries[0].resource?.type).toBe("workflow");
		expect(entries[0].resource?.id).toBe("/users/create");
		expect(entries[0].details).toEqual({ roles: ["developer"] });
	});

	it("should log workflow executions", async () => {
		const sink = new InMemoryAuditSink();
		logger = new AuditLogger({ sinks: [sink], bufferSize: 1, flushIntervalMs: 0 });

		logger.logWorkflowExecution({
			workflowName: "create-user",
			workflowPath: "/users/create",
			success: true,
			durationMs: 150,
			requestId: "req-123",
		});

		await logger.flush();

		const entries = sink.getEntries();
		expect(entries[0].category).toBe("workflow");
		expect(entries[0].durationMs).toBe(150);
		expect(entries[0].requestId).toBe("req-123");
	});

	it("should log config changes", async () => {
		const sink = new InMemoryAuditSink();
		logger = new AuditLogger({ sinks: [sink], bufferSize: 1, flushIntervalMs: 0 });

		logger.logConfigChange({
			action: "update",
			resourceType: "workflow",
			resourceId: "/users/create",
			actor: { sub: "admin-1", name: "Admin" },
			details: { field: "trigger", old: "GET", new: "POST" },
		});

		await logger.flush();

		const entries = sink.getEntries();
		expect(entries[0].category).toBe("config");
		expect(entries[0].action).toBe("config.update");
		expect(entries[0].severity).toBe("warn");
	});

	it("should log security events", async () => {
		const sink = new InMemoryAuditSink();
		logger = new AuditLogger({ sinks: [sink], bufferSize: 1, flushIntervalMs: 0 });

		logger.logSecurityEvent({
			action: "rate_limit_exceeded",
			severity: "error",
			details: { ip: "192.168.1.100", limit: 100 },
		});

		await logger.flush();

		const entries = sink.getEntries();
		expect(entries[0].category).toBe("security");
		expect(entries[0].severity).toBe("error");
	});

	it("should respect minimum severity", async () => {
		const sink = new InMemoryAuditSink();
		logger = new AuditLogger({
			sinks: [sink],
			minSeverity: "warn",
			bufferSize: 1,
			flushIntervalMs: 0,
		});

		logger.logAuth({ action: "login", success: true, identity: { sub: "u" } });
		logger.logAuth({ action: "login", success: false, error: "bad" });

		await logger.flush();

		const entries = sink.getEntries();
		// Only the failed (warn) entry should be logged
		expect(entries.length).toBe(1);
		expect(entries[0].severity).toBe("warn");
	});

	it("should auto-flush when buffer is full", async () => {
		const sink = new InMemoryAuditSink();
		logger = new AuditLogger({
			sinks: [sink],
			bufferSize: 2,
			flushIntervalMs: 0,
		});

		logger.logAuth({ action: "login", success: true, identity: { sub: "u1" } });
		logger.logAuth({ action: "login", success: true, identity: { sub: "u2" } });

		// Wait for auto-flush
		await new Promise((r) => setTimeout(r, 50));

		const entries = sink.getEntries();
		expect(entries.length).toBe(2);
	});

	it("should write to multiple sinks", async () => {
		const sink1 = new InMemoryAuditSink();
		const sink2 = new InMemoryAuditSink();

		logger = new AuditLogger({
			sinks: [sink1, sink2],
			bufferSize: 1,
			flushIntervalMs: 0,
		});

		logger.logAuth({ action: "login", success: true, identity: { sub: "u" } });
		await logger.flush();

		expect(sink1.getEntries().length).toBe(1);
		expect(sink2.getEntries().length).toBe(1);
	});

	it("should track entry count", async () => {
		const sink = new InMemoryAuditSink();
		logger = new AuditLogger({ sinks: [sink], flushIntervalMs: 0 });

		logger.logAuth({ action: "login", success: true, identity: { sub: "u1" } });
		logger.logAuth({ action: "login", success: true, identity: { sub: "u2" } });
		logger.logAuth({ action: "login", success: true, identity: { sub: "u3" } });

		expect(logger.getEntryCount()).toBe(3);
	});

	it("should generate unique entry IDs", async () => {
		const sink = new InMemoryAuditSink();
		logger = new AuditLogger({ sinks: [sink], bufferSize: 10, flushIntervalMs: 0 });

		logger.logAuth({ action: "login", success: true, identity: { sub: "u1" } });
		logger.logAuth({ action: "login", success: true, identity: { sub: "u2" } });

		await logger.flush();

		const entries = sink.getEntries();
		expect(entries[0].id).not.toBe(entries[1].id);
	});

	it("should handle sink errors gracefully", async () => {
		const failingSink: AuditSink = {
			name: "failing",
			write: async () => { throw new Error("Sink failed"); },
		};

		logger = new AuditLogger({ sinks: [failingSink], bufferSize: 1, flushIntervalMs: 0 });

		// Should not throw
		logger.logAuth({ action: "login", success: true, identity: { sub: "u" } });
		await logger.flush();
	});
});

describe("InMemoryAuditSink", () => {
	it("should query entries by category", () => {
		const sink = new InMemoryAuditSink();
		sink.write({ id: "1", timestamp: new Date().toISOString(), category: "auth", severity: "info", action: "login", success: true });
		sink.write({ id: "2", timestamp: new Date().toISOString(), category: "authz", severity: "info", action: "check", success: true });
		sink.write({ id: "3", timestamp: new Date().toISOString(), category: "auth", severity: "warn", action: "logout", success: true });

		const results = sink.query({ category: "auth" });
		expect(results.length).toBe(2);
	});

	it("should query entries by severity", () => {
		const sink = new InMemoryAuditSink();
		sink.write({ id: "1", timestamp: new Date().toISOString(), category: "auth", severity: "info", action: "login", success: true });
		sink.write({ id: "2", timestamp: new Date().toISOString(), category: "auth", severity: "error", action: "fail", success: false });

		const results = sink.query({ severity: "error" });
		expect(results.length).toBe(1);
		expect(results[0].action).toBe("fail");
	});

	it("should limit results", () => {
		const sink = new InMemoryAuditSink();
		for (let i = 0; i < 10; i++) {
			sink.write({ id: `${i}`, timestamp: new Date().toISOString(), category: "auth", severity: "info", action: "test", success: true });
		}

		const results = sink.query({ limit: 3 });
		expect(results.length).toBe(3);
	});

	it("should clear entries", () => {
		const sink = new InMemoryAuditSink();
		sink.write({ id: "1", timestamp: new Date().toISOString(), category: "auth", severity: "info", action: "test", success: true });
		expect(sink.getEntries().length).toBe(1);

		sink.clear();
		expect(sink.getEntries().length).toBe(0);
	});

	it("should enforce max entries (ring buffer)", () => {
		const sink = new InMemoryAuditSink(3);
		sink.write({ id: "1", timestamp: new Date().toISOString(), category: "auth", severity: "info", action: "a", success: true });
		sink.write({ id: "2", timestamp: new Date().toISOString(), category: "auth", severity: "info", action: "b", success: true });
		sink.write({ id: "3", timestamp: new Date().toISOString(), category: "auth", severity: "info", action: "c", success: true });
		sink.write({ id: "4", timestamp: new Date().toISOString(), category: "auth", severity: "info", action: "d", success: true });

		const entries = sink.getEntries();
		expect(entries.length).toBe(3);
		expect(entries[0].id).toBe("2"); // First entry was evicted
	});
});

describe("ConsoleAuditSink", () => {
	it("should write to console", () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const sink = new ConsoleAuditSink();

		sink.write({
			id: "1",
			timestamp: new Date().toISOString(),
			category: "auth",
			severity: "info",
			action: "login",
			success: true,
		});

		expect(consoleSpy).toHaveBeenCalledOnce();
		consoleSpy.mockRestore();
	});

	it("should use console.error for error severity", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const sink = new ConsoleAuditSink();

		sink.write({
			id: "1",
			timestamp: new Date().toISOString(),
			category: "auth",
			severity: "error",
			action: "fail",
			success: false,
		});

		expect(errorSpy).toHaveBeenCalledOnce();
		errorSpy.mockRestore();
	});
});
