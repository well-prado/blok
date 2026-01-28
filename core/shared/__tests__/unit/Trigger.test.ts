import { describe, expect, it } from "vitest";
import Trigger from "../../src/Trigger";

class TestTrigger extends Trigger {
	public listenCalled = false;

	listen(): void {
		this.listenCalled = true;
	}
}

describe("Trigger", () => {
	it("should allow concrete subclass to implement listen()", () => {
		const trigger = new TestTrigger();
		trigger.listen();
		expect(trigger.listenCalled).toBe(true);
	});

	it("should be an instance of Trigger", () => {
		const trigger = new TestTrigger();
		expect(trigger).toBeInstanceOf(Trigger);
	});
});
