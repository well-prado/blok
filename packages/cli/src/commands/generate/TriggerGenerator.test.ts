/**
 * TriggerGenerator Tests
 *
 * Tests the trigger structural validation (non-AI parts)
 */

import { describe, expect, it } from "vitest";
import TriggerGenerator from "./TriggerGenerator.js";

describe("TriggerGenerator", () => {
	describe("validateTriggerStructure (via reflection)", () => {
		// Access private method through bracket notation for testing
		const generator = new TriggerGenerator();
		const validate = (code: string) => (generator as unknown as { validateTriggerStructure: (code: string) => { valid: boolean; errors: string[]; warnings: string[] } }).validateTriggerStructure(code);

		it("should pass for valid trigger code", () => {
			const validCode = `
import TriggerBase from "@nanoservice-ts/runner/TriggerBase";
import { NodeMap } from "@nanoservice-ts/runner";

export default class MyTrigger extends TriggerBase {
  constructor() {
    super();
    this.loadNodes();
    this.loadWorkflows();
  }

  private loadNodes() {
    // load nodes
  }

  private loadWorkflows() {
    // load workflows
  }

  async start() {
    const ctx = this.createContext();
    ctx.request = { body: {} };
  }
}
      `;

			const result = validate(validCode);
			expect(result.valid).toBe(true);
			expect(result.errors.length).toBe(0);
		});

		it("should fail for trigger not extending TriggerBase", () => {
			const code = `
export default class MyTrigger {
  constructor() {
    this.loadNodes();
    this.loadWorkflows();
  }

  private loadNodes() {}
  private loadWorkflows() {}

  async start() {
    const ctx = this.createContext();
  }
}
      `;

			const result = validate(code);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("TriggerBase"))).toBe(true);
		});

		it("should fail for trigger missing loadNodes", () => {
			const code = `
import TriggerBase from "@nanoservice-ts/runner/TriggerBase";

export default class MyTrigger extends TriggerBase {
  constructor() {
    super();
    this.loadWorkflows();
  }

  private loadWorkflows() {}

  async start() {
    const ctx = this.createContext();
  }
}
      `;

			const result = validate(code);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("loadNodes"))).toBe(true);
		});

		it("should fail for trigger missing loadWorkflows", () => {
			const code = `
import TriggerBase from "@nanoservice-ts/runner/TriggerBase";

export default class MyTrigger extends TriggerBase {
  constructor() {
    super();
    this.loadNodes();
  }

  private loadNodes() {}

  async start() {
    const ctx = this.createContext();
  }
}
      `;

			const result = validate(code);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("loadWorkflows"))).toBe(true);
		});

		it("should fail for trigger missing createContext", () => {
			const code = `
import TriggerBase from "@nanoservice-ts/runner/TriggerBase";

export default class MyTrigger extends TriggerBase {
  constructor() {
    super();
    this.loadNodes();
    this.loadWorkflows();
  }

  private loadNodes() {}
  private loadWorkflows() {}

  async start() {
    // does not build context
  }
}
      `;

			const result = validate(code);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("createContext"))).toBe(true);
		});

		it("should fail for constructor without super()", () => {
			const code = `
import TriggerBase from "@nanoservice-ts/runner/TriggerBase";

export default class MyTrigger extends TriggerBase {
  constructor() {
    this.loadNodes();
    this.loadWorkflows();
  }

  private loadNodes() {}
  private loadWorkflows() {}

  async start() {
    const ctx = this.createContext();
  }
}
      `;

			const result = validate(code);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("super()"))).toBe(true);
		});

		it("should warn when request data is not populated on context", () => {
			const code = `
import TriggerBase from "@nanoservice-ts/runner/TriggerBase";

export default class MyTrigger extends TriggerBase {
  constructor() {
    super();
    this.loadNodes();
    this.loadWorkflows();
  }

  private loadNodes() {}
  private loadWorkflows() {}

  async start() {
    const c = this.createContext();
    // does not set request data
  }
}
      `;

			const result = validate(code);
			expect(result.valid).toBe(true);
			expect(result.warnings.some(w => w.includes("ctx.request") || w.includes("event data"))).toBe(true);
		});
	});

	describe("buildEnhancedPrompt (via reflection)", () => {
		const generator = new TriggerGenerator();
		const buildPrompt = (userPrompt: string, triggerType: string, triggerName: string) =>
			(generator as unknown as { buildEnhancedPrompt: (u: string, t: string, n: string) => string }).buildEnhancedPrompt(userPrompt, triggerType, triggerName);

		it("should include trigger type in prompt", () => {
			const result = buildPrompt("Process user events", "queue", "user-queue");
			expect(result).toContain("queue");
			expect(result).toContain("user-queue");
			expect(result).toContain("Process user events");
		});

		it("should include queue-specific guidance for queue type", () => {
			const result = buildPrompt("Process messages", "queue", "my-queue");
			expect(result).toContain("message queue broker");
			expect(result).toContain("ack/nack");
		});

		it("should include pubsub-specific guidance for pubsub type", () => {
			const result = buildPrompt("Process events", "pubsub", "my-pubsub");
			expect(result).toContain("pub/sub provider");
		});

		it("should include cron-specific guidance for cron type", () => {
			const result = buildPrompt("Run daily", "cron", "daily-job");
			expect(result).toContain("cron expressions");
			expect(result).toContain("timezone");
		});

		it("should include webhook-specific guidance for webhook type", () => {
			const result = buildPrompt("Handle webhooks", "webhook", "github-webhook");
			expect(result).toContain("signature verification");
		});

		it("should include websocket-specific guidance for websocket type", () => {
			const result = buildPrompt("Real-time chat", "websocket", "chat-ws");
			expect(result).toContain("WebSocket server");
		});

		it("should include sse-specific guidance for sse type", () => {
			const result = buildPrompt("Stream events", "sse", "event-stream");
			expect(result).toContain("SSE");
		});

		it("should handle custom trigger types", () => {
			const result = buildPrompt("Custom trigger", "custom", "my-custom");
			expect(result).toContain("custom");
		});
	});
});
