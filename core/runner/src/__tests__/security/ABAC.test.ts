import { describe, expect, it } from "vitest";
import { ABACEngine, type ABACPolicy, type ABACRequest, createDefaultABAC } from "../../security/ABAC";

// ──────────────────── Helper ────────────────────

function makeRequest(overrides?: Partial<ABACRequest>): ABACRequest {
	return {
		subject: { sub: "user-1", roles: ["developer"], department: "engineering" },
		resource: { type: "workflow", id: "/api/users" },
		action: "execute",
		environment: { hour: 14, ip: "10.0.0.1", dayOfWeek: "Monday" },
		...overrides,
	};
}

// ──────────────────── ABACEngine ────────────────────

describe("ABACEngine", () => {
	describe("policy management", () => {
		it("should add and retrieve policies", () => {
			const engine = new ABACEngine();
			const policy: ABACPolicy = {
				id: "test-policy",
				effect: "allow",
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			};

			engine.addPolicy(policy);
			expect(engine.getPolicy("test-policy")).toEqual(policy);
		});

		it("should remove policies", () => {
			const engine = new ABACEngine();
			engine.addPolicy({ id: "p1", effect: "allow", conditions: {} });
			expect(engine.getPolicy("p1")).toBeDefined();
			engine.removePolicy("p1");
			expect(engine.getPolicy("p1")).toBeUndefined();
		});

		it("should list policies sorted by priority", () => {
			const engine = new ABACEngine();
			engine.addPolicy({ id: "low", effect: "allow", priority: 10, conditions: {} });
			engine.addPolicy({ id: "high", effect: "allow", priority: 100, conditions: {} });
			engine.addPolicy({ id: "mid", effect: "allow", priority: 50, conditions: {} });

			const policies = engine.getPolicies();
			expect(policies.map((p) => p.id)).toEqual(["high", "mid", "low"]);
		});

		it("should update existing policy", () => {
			const engine = new ABACEngine();
			engine.addPolicy({ id: "p1", effect: "allow", description: "v1", conditions: {} });
			engine.addPolicy({ id: "p1", effect: "deny", description: "v2", conditions: {} });

			expect(engine.getPolicy("p1")?.effect).toBe("deny");
			expect(engine.getPolicy("p1")?.description).toBe("v2");
		});
	});

	describe("basic evaluation", () => {
		it("should deny when no policies and default is deny", () => {
			const engine = new ABACEngine();
			const result = engine.evaluate(makeRequest());
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("default effect is deny");
		});

		it("should allow when no policies and default is allow", () => {
			const engine = new ABACEngine({ defaultEffect: "allow" });
			const result = engine.evaluate(makeRequest());
			expect(result.allowed).toBe(true);
			expect(result.reason).toContain("default effect is allow");
		});

		it("should allow when conditions are met for allow policy", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "allow-engineering",
				effect: "allow",
				conditions: {
					all: [{ attribute: "subject.department", operator: "equals", value: "engineering" }],
				},
			});

			const result = engine.evaluate(makeRequest());
			expect(result.allowed).toBe(true);
			expect(result.matchedPolicy?.id).toBe("allow-engineering");
		});

		it("should deny when conditions are met for deny policy", () => {
			const engine = new ABACEngine({ defaultEffect: "allow" });
			engine.addPolicy({
				id: "deny-marketing",
				effect: "deny",
				conditions: {
					all: [{ attribute: "subject.department", operator: "equals", value: "marketing" }],
				},
			});

			const result = engine.evaluate(makeRequest({ subject: { sub: "u2", department: "marketing" } }));
			expect(result.allowed).toBe(false);
			expect(result.matchedPolicy?.id).toBe("deny-marketing");
		});

		it("should skip disabled policies", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "disabled-allow",
				effect: "allow",
				enabled: false,
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			const result = engine.evaluate(makeRequest());
			expect(result.allowed).toBe(false);
			expect(result.evaluatedPolicies).toHaveLength(0);
		});
	});

	describe("deny takes precedence", () => {
		it("should deny even if allow policy also matches", () => {
			const engine = new ABACEngine();

			engine.addPolicy({
				id: "allow-all",
				effect: "allow",
				priority: 0,
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			engine.addPolicy({
				id: "deny-blocked",
				effect: "deny",
				priority: 100,
				conditions: {
					all: [{ attribute: "environment.blocked", operator: "equals", value: true }],
				},
			});

			const result = engine.evaluate(makeRequest({ environment: { blocked: true } }));
			expect(result.allowed).toBe(false);
			expect(result.matchedPolicy?.id).toBe("deny-blocked");
		});

		it("should allow if deny conditions are not met", () => {
			const engine = new ABACEngine();

			engine.addPolicy({
				id: "allow-all",
				effect: "allow",
				priority: 0,
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			engine.addPolicy({
				id: "deny-blocked",
				effect: "deny",
				priority: 100,
				conditions: {
					all: [{ attribute: "environment.blocked", operator: "equals", value: true }],
				},
			});

			const result = engine.evaluate(makeRequest({ environment: { blocked: false } }));
			expect(result.allowed).toBe(true);
			expect(result.matchedPolicy?.id).toBe("allow-all");
		});
	});

	describe("target matching", () => {
		it("should match by resource type", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "workflow-only",
				effect: "allow",
				target: { resource: "workflow" },
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ resource: { type: "node", id: "n1" } })).allowed).toBe(false);
		});

		it("should match by resource pattern", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "api-only",
				effect: "allow",
				target: { resourcePattern: "/api/*" },
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ resource: { type: "workflow", id: "/admin/users" } })).allowed).toBe(false);
		});

		it("should match by action", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "execute-only",
				effect: "allow",
				target: { actions: ["execute"] },
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ action: "delete" })).allowed).toBe(false);
		});

		it("should match wildcard resource", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "any-resource",
				effect: "allow",
				target: { resource: "*" },
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ resource: { type: "trigger", id: "t1" } })).allowed).toBe(true);
		});

		it("should match wildcard action", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "any-action",
				effect: "allow",
				target: { actions: ["*"] },
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			expect(engine.evaluate(makeRequest({ action: "read" })).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ action: "delete" })).allowed).toBe(true);
		});

		it("should apply policy with no target to all requests", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "global",
				effect: "allow",
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ resource: { type: "anything", id: "x" } })).allowed).toBe(true);
		});
	});

	describe("comparison operators", () => {
		function evalCondition(attribute: string, operator: string, value: unknown, request?: ABACRequest): boolean {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: {
					all: [{ attribute, operator: operator as any, value }],
				},
			});
			return engine.evaluate(request ?? makeRequest()).allowed;
		}

		it("equals", () => {
			expect(evalCondition("subject.department", "equals", "engineering")).toBe(true);
			expect(evalCondition("subject.department", "equals", "marketing")).toBe(false);
		});

		it("not_equals", () => {
			expect(evalCondition("subject.department", "not_equals", "marketing")).toBe(true);
			expect(evalCondition("subject.department", "not_equals", "engineering")).toBe(false);
		});

		it("in", () => {
			expect(evalCondition("subject.department", "in", ["engineering", "sales"])).toBe(true);
			expect(evalCondition("subject.department", "in", ["marketing", "sales"])).toBe(false);
		});

		it("not_in", () => {
			expect(evalCondition("subject.department", "not_in", ["marketing", "sales"])).toBe(true);
			expect(evalCondition("subject.department", "not_in", ["engineering", "sales"])).toBe(false);
		});

		it("contains (array)", () => {
			expect(evalCondition("subject.roles", "contains", "developer")).toBe(true);
			expect(evalCondition("subject.roles", "contains", "admin")).toBe(false);
		});

		it("contains (string)", () => {
			expect(evalCondition("resource.id", "contains", "/api")).toBe(true);
			expect(evalCondition("resource.id", "contains", "/admin")).toBe(false);
		});

		it("not_contains (array)", () => {
			expect(evalCondition("subject.roles", "not_contains", "admin")).toBe(true);
			expect(evalCondition("subject.roles", "not_contains", "developer")).toBe(false);
		});

		it("not_contains (string)", () => {
			expect(evalCondition("resource.id", "not_contains", "/admin")).toBe(true);
			expect(evalCondition("resource.id", "not_contains", "/api")).toBe(false);
		});

		it("matches (regex)", () => {
			expect(evalCondition("resource.id", "matches", "^/api/.*$")).toBe(true);
			expect(evalCondition("resource.id", "matches", "^/admin/.*$")).toBe(false);
		});

		it("matches handles invalid regex gracefully", () => {
			expect(evalCondition("resource.id", "matches", "[invalid")).toBe(false);
		});

		it("gt", () => {
			expect(evalCondition("environment.hour", "gt", 10)).toBe(true);
			expect(evalCondition("environment.hour", "gt", 14)).toBe(false);
			expect(evalCondition("environment.hour", "gt", 20)).toBe(false);
		});

		it("lt", () => {
			expect(evalCondition("environment.hour", "lt", 20)).toBe(true);
			expect(evalCondition("environment.hour", "lt", 14)).toBe(false);
			expect(evalCondition("environment.hour", "lt", 10)).toBe(false);
		});

		it("gte", () => {
			expect(evalCondition("environment.hour", "gte", 14)).toBe(true);
			expect(evalCondition("environment.hour", "gte", 10)).toBe(true);
			expect(evalCondition("environment.hour", "gte", 15)).toBe(false);
		});

		it("lte", () => {
			expect(evalCondition("environment.hour", "lte", 14)).toBe(true);
			expect(evalCondition("environment.hour", "lte", 20)).toBe(true);
			expect(evalCondition("environment.hour", "lte", 13)).toBe(false);
		});

		it("between", () => {
			expect(evalCondition("environment.hour", "between", [9, 17])).toBe(true);
			expect(evalCondition("environment.hour", "between", [15, 20])).toBe(false);
			expect(evalCondition("environment.hour", "between", [14, 14])).toBe(true);
		});

		it("exists", () => {
			expect(evalCondition("subject.department", "exists", undefined)).toBe(true);
			expect(evalCondition("subject.nonexistent", "exists", undefined)).toBe(false);
		});

		it("not_exists", () => {
			expect(evalCondition("subject.nonexistent", "not_exists", undefined)).toBe(true);
			expect(evalCondition("subject.department", "not_exists", undefined)).toBe(false);
		});

		it("returns false for non-numeric gt/lt with non-numbers", () => {
			expect(evalCondition("subject.department", "gt", 10)).toBe(false);
			expect(evalCondition("subject.department", "lt", 10)).toBe(false);
		});

		it("returns false for unknown operator", () => {
			expect(evalCondition("subject.department", "unknown_op" as any, "x")).toBe(false);
		});
	});

	describe("attribute resolution", () => {
		it("should resolve subject attributes", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: { all: [{ attribute: "subject.sub", operator: "equals", value: "user-1" }] },
			});
			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
		});

		it("should resolve resource attributes", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: { all: [{ attribute: "resource.type", operator: "equals", value: "workflow" }] },
			});
			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
		});

		it("should resolve action attribute", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: { all: [{ attribute: "action", operator: "equals", value: "execute" }] },
			});
			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
		});

		it("should resolve environment attributes", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: { all: [{ attribute: "environment.ip", operator: "equals", value: "10.0.0.1" }] },
			});
			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
		});

		it("should resolve nested attributes", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: {
					all: [{ attribute: "subject.metadata.team", operator: "equals", value: "platform" }],
				},
			});

			const result = engine.evaluate(makeRequest({ subject: { sub: "u1", metadata: { team: "platform" } } }));
			expect(result.allowed).toBe(true);
		});

		it("should return undefined for unknown root", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: { all: [{ attribute: "unknown.path", operator: "exists" }] },
			});
			expect(engine.evaluate(makeRequest()).allowed).toBe(false);
		});

		it("should handle null/undefined in attribute path", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: { all: [{ attribute: "subject.foo.bar.baz", operator: "exists" }] },
			});
			expect(engine.evaluate(makeRequest()).allowed).toBe(false);
		});

		it("should handle missing environment", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: { all: [{ attribute: "environment.ip", operator: "exists" }] },
			});
			const result = engine.evaluate({
				subject: { sub: "u1" },
				resource: { type: "workflow", id: "w1" },
				action: "execute",
				// no environment
			});
			expect(result.allowed).toBe(false);
		});
	});

	describe("valueRef (attribute-to-attribute comparison)", () => {
		it("should compare two attributes using valueRef", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "owner-check",
				effect: "allow",
				conditions: {
					all: [{ attribute: "resource.owner", operator: "equals", valueRef: "subject.sub" }],
				},
			});

			// Owner matches subject
			expect(
				engine.evaluate(
					makeRequest({
						subject: { sub: "user-1" },
						resource: { type: "workflow", id: "w1", owner: "user-1" },
					}),
				).allowed,
			).toBe(true);

			// Owner does not match subject
			expect(
				engine.evaluate(
					makeRequest({
						subject: { sub: "user-1" },
						resource: { type: "workflow", id: "w1", owner: "user-2" },
					}),
				).allowed,
			).toBe(false);
		});

		it("should prefer valueRef over value when both are set", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "ref-wins",
				effect: "allow",
				conditions: {
					all: [{ attribute: "subject.sub", operator: "equals", value: "wrong-value", valueRef: "resource.owner" }],
				},
			});

			const result = engine.evaluate(
				makeRequest({
					subject: { sub: "user-1" },
					resource: { type: "workflow", id: "w1", owner: "user-1" },
				}),
			);
			expect(result.allowed).toBe(true);
		});
	});

	describe("logical operators", () => {
		it("should handle ALL (AND) — all conditions must be true", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: {
					all: [
						{ attribute: "subject.department", operator: "equals", value: "engineering" },
						{ attribute: "environment.hour", operator: "gte", value: 9 },
						{ attribute: "environment.hour", operator: "lt", value: 17 },
					],
				},
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ environment: { hour: 22 } })).allowed).toBe(false);
		});

		it("should handle ANY (OR) — at least one must be true", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: {
					any: [
						{ attribute: "subject.department", operator: "equals", value: "marketing" },
						{ attribute: "subject.department", operator: "equals", value: "engineering" },
					],
				},
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ subject: { sub: "u2", department: "sales" } })).allowed).toBe(false);
		});

		it("should handle NONE (NOR) — no condition may be true", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: {
					none: [
						{ attribute: "subject.department", operator: "equals", value: "marketing" },
						{ attribute: "subject.department", operator: "equals", value: "sales" },
					],
				},
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ subject: { sub: "u2", department: "marketing" } })).allowed).toBe(false);
		});

		it("should combine ALL + ANY in one group", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: {
					all: [{ attribute: "subject.sub", operator: "exists" }],
					any: [
						{ attribute: "subject.department", operator: "equals", value: "engineering" },
						{ attribute: "subject.department", operator: "equals", value: "product" },
					],
				},
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ subject: { sub: "u2", department: "sales" } })).allowed).toBe(false);
		});

		it("should combine ALL + NONE", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "test",
				effect: "allow",
				conditions: {
					all: [{ attribute: "subject.sub", operator: "exists" }],
					none: [{ attribute: "environment.blocked", operator: "equals", value: true }],
				},
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ environment: { blocked: true } })).allowed).toBe(false);
		});

		it("should handle nested condition groups", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "nested",
				effect: "allow",
				conditions: {
					all: [
						{
							any: [
								{ attribute: "subject.department", operator: "equals", value: "engineering" },
								{ attribute: "subject.department", operator: "equals", value: "devops" },
							],
						},
						{
							all: [
								{ attribute: "environment.hour", operator: "gte", value: 9 },
								{ attribute: "environment.hour", operator: "lt", value: 17 },
							],
						},
					],
				},
			});

			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ subject: { sub: "u2", department: "devops" } })).allowed).toBe(true);
			expect(engine.evaluate(makeRequest({ environment: { hour: 22 } })).allowed).toBe(false);
			expect(engine.evaluate(makeRequest({ subject: { sub: "u2", department: "sales" } })).allowed).toBe(false);
		});

		it("should treat empty condition group as always true", () => {
			const engine = new ABACEngine();
			engine.addPolicy({ id: "test", effect: "allow", conditions: {} });
			expect(engine.evaluate(makeRequest()).allowed).toBe(true);
		});
	});

	describe("priority ordering", () => {
		it("should evaluate higher-priority policies first", () => {
			const engine = new ABACEngine();

			engine.addPolicy({
				id: "low-allow",
				effect: "allow",
				priority: 10,
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			engine.addPolicy({
				id: "high-deny",
				effect: "deny",
				priority: 100,
				conditions: {
					all: [{ attribute: "subject.department", operator: "equals", value: "engineering" }],
				},
			});

			const result = engine.evaluate(makeRequest());
			expect(result.allowed).toBe(false);
			expect(result.matchedPolicy?.id).toBe("high-deny");
		});
	});

	describe("evaluated policies tracking", () => {
		it("should track all evaluated policies in result", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "p1",
				effect: "allow",
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});
			engine.addPolicy({
				id: "p2",
				effect: "allow",
				conditions: { all: [{ attribute: "subject.nonexistent", operator: "exists" }] },
			});

			const result = engine.evaluate(makeRequest());
			expect(result.evaluatedPolicies).toHaveLength(2);

			const p1 = result.evaluatedPolicies.find((p) => p.policyId === "p1");
			const p2 = result.evaluatedPolicies.find((p) => p.policyId === "p2");
			expect(p1?.matched).toBe(true);
			expect(p2?.matched).toBe(false);
		});

		it("should mark non-targeted policies as not matched", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "node-only",
				effect: "allow",
				target: { resource: "node" },
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});

			const result = engine.evaluate(makeRequest());
			expect(result.evaluatedPolicies[0].matched).toBe(false);
		});
	});

	describe("JSON serialization", () => {
		it("should export and import policies", () => {
			const engine = new ABACEngine();
			engine.addPolicy({
				id: "p1",
				effect: "allow",
				priority: 100,
				conditions: { all: [{ attribute: "subject.sub", operator: "exists" }] },
			});
			engine.addPolicy({
				id: "p2",
				effect: "deny",
				conditions: {
					any: [{ attribute: "environment.blocked", operator: "equals", value: true }],
				},
			});

			const json = engine.toJSON();
			expect(json.policies).toHaveLength(2);
			expect(json.defaultEffect).toBe("deny");

			const engine2 = new ABACEngine();
			engine2.fromJSON(json);

			expect(engine2.getPolicy("p1")).toBeDefined();
			expect(engine2.getPolicy("p2")).toBeDefined();
			expect(engine2.getPolicies()).toHaveLength(2);
		});

		it("should restore defaultEffect from JSON", () => {
			const engine = new ABACEngine({ defaultEffect: "allow" });
			const json = engine.toJSON();

			const engine2 = new ABACEngine();
			engine2.fromJSON(json);

			// With no policies and defaultEffect=allow, should allow
			const result = engine2.evaluate(makeRequest());
			expect(result.allowed).toBe(true);
		});

		it("should clear existing policies on import", () => {
			const engine = new ABACEngine();
			engine.addPolicy({ id: "existing", effect: "allow", conditions: {} });

			engine.fromJSON({ policies: [{ id: "new", effect: "deny", conditions: {} }] });

			expect(engine.getPolicy("existing")).toBeUndefined();
			expect(engine.getPolicy("new")).toBeDefined();
		});
	});

	describe("real-world scenarios", () => {
		it("business hours + department restriction", () => {
			const engine = new ABACEngine();

			engine.addPolicy({
				id: "business-hours-eng",
				description: "Engineering can execute workflows during business hours",
				effect: "allow",
				target: { resource: "workflow", actions: ["execute"] },
				conditions: {
					all: [
						{ attribute: "subject.department", operator: "in", value: ["engineering", "devops"] },
						{ attribute: "environment.hour", operator: "gte", value: 9 },
						{ attribute: "environment.hour", operator: "lt", value: 17 },
					],
				},
			});

			// During business hours, engineering → allowed
			expect(engine.evaluate(makeRequest()).allowed).toBe(true);

			// After hours → denied
			expect(engine.evaluate(makeRequest({ environment: { hour: 22 } })).allowed).toBe(false);

			// Wrong department → denied
			expect(engine.evaluate(makeRequest({ subject: { sub: "u", department: "marketing" } })).allowed).toBe(false);
		});

		it("IP-based geo restriction with department override", () => {
			const engine = new ABACEngine();

			// Deny non-corporate IPs
			engine.addPolicy({
				id: "corp-network-only",
				effect: "deny",
				priority: 100,
				conditions: {
					none: [{ attribute: "environment.ip", operator: "matches", value: "^10\\.0\\..*" }],
				},
			});

			// Allow from corporate network
			engine.addPolicy({
				id: "corp-allow",
				effect: "allow",
				priority: 50,
				conditions: {
					all: [{ attribute: "subject.sub", operator: "exists" }],
				},
			});

			// Corporate IP → allowed
			expect(engine.evaluate(makeRequest()).allowed).toBe(true);

			// Non-corporate IP → denied
			expect(engine.evaluate(makeRequest({ environment: { ip: "203.0.113.1" } })).allowed).toBe(false);
		});

		it("resource sensitivity classification", () => {
			const engine = new ABACEngine();

			engine.addPolicy({
				id: "classified-access",
				effect: "allow",
				conditions: {
					all: [{ attribute: "resource.classification", operator: "in", value: ["public", "internal"] }],
				},
			});

			engine.addPolicy({
				id: "secret-access",
				effect: "allow",
				priority: 10,
				conditions: {
					all: [
						{ attribute: "resource.classification", operator: "equals", value: "secret" },
						{ attribute: "subject.clearanceLevel", operator: "gte", value: 3 },
					],
				},
			});

			// Public resource → allowed
			expect(
				engine.evaluate(makeRequest({ resource: { type: "workflow", id: "w1", classification: "public" } })).allowed,
			).toBe(true);

			// Secret + low clearance → denied
			expect(
				engine.evaluate(
					makeRequest({
						subject: { sub: "u1", clearanceLevel: 1 },
						resource: { type: "workflow", id: "w1", classification: "secret" },
					}),
				).allowed,
			).toBe(false);

			// Secret + high clearance → allowed
			expect(
				engine.evaluate(
					makeRequest({
						subject: { sub: "u1", clearanceLevel: 5 },
						resource: { type: "workflow", id: "w1", classification: "secret" },
					}),
				).allowed,
			).toBe(true);
		});
	});
});

// ──────────────────── createDefaultABAC ────────────────────

describe("createDefaultABAC", () => {
	it("should create engine with predefined policies", () => {
		const engine = createDefaultABAC();
		const policies = engine.getPolicies();

		expect(policies.length).toBe(4);
		expect(policies.map((p) => p.id)).toContain("admin-override");
		expect(policies.map((p) => p.id)).toContain("block-denied-ips");
		expect(policies.map((p) => p.id)).toContain("service-execute");
		expect(policies.map((p) => p.id)).toContain("resource-owner-access");
	});

	it("should allow admin access unconditionally", () => {
		const engine = createDefaultABAC();

		const result = engine.evaluate({
			subject: { sub: "admin-1", roles: ["admin"] },
			resource: { type: "workflow", id: "/secret/endpoint" },
			action: "delete",
		});
		expect(result.allowed).toBe(true);
		expect(result.matchedPolicy?.id).toBe("admin-override");
	});

	it("should deny blocked IPs", () => {
		const engine = createDefaultABAC();

		const result = engine.evaluate({
			subject: { sub: "user-1", roles: ["developer"] },
			resource: { type: "workflow", id: "/api/users" },
			action: "execute",
			environment: { blocked: true },
		});
		expect(result.allowed).toBe(false);
		expect(result.matchedPolicy?.id).toBe("block-denied-ips");
	});

	it("should allow service accounts to execute workflows", () => {
		const engine = createDefaultABAC();

		const result = engine.evaluate({
			subject: { sub: "svc-1", roles: ["service"] },
			resource: { type: "workflow", id: "/api/users" },
			action: "execute",
		});
		expect(result.allowed).toBe(true);
		expect(result.matchedPolicy?.id).toBe("service-execute");
	});

	it("should allow resource owners to access their resources", () => {
		const engine = createDefaultABAC();

		const result = engine.evaluate({
			subject: { sub: "user-42", roles: ["developer"] },
			resource: { type: "workflow", id: "/my/workflow", owner: "user-42" },
			action: "update",
		});
		expect(result.allowed).toBe(true);
		expect(result.matchedPolicy?.id).toBe("resource-owner-access");
	});

	it("should deny non-owners from accessing owned resources", () => {
		const engine = createDefaultABAC();

		const result = engine.evaluate({
			subject: { sub: "user-1", roles: ["developer"] },
			resource: { type: "workflow", id: "/their/workflow", owner: "user-42" },
			action: "update",
		});
		expect(result.allowed).toBe(false);
	});

	it("should deny blocked IPs even for admins (deny priority > allow)", () => {
		const engine = createDefaultABAC();

		// admin-override has priority 1000, block-denied-ips has priority 900
		// But deny always takes precedence per evaluation rules
		// Actually — admin-override is evaluated first (priority 1000)
		// and will match before block-denied-ips is reached.
		// So admins ARE allowed even from blocked IPs in the default config.
		const result = engine.evaluate({
			subject: { sub: "admin-1", roles: ["admin"] },
			resource: { type: "workflow", id: "/api/users" },
			action: "execute",
			environment: { blocked: true },
		});
		// Admin override is at priority 1000 (allow), block-denied-ips at 900 (deny)
		// Since deny short-circuits, block-denied-ips at 900 is evaluated second, and DOES match.
		// But wait — the engine evaluates by priority. admin-override at 1000 is first, it's "allow".
		// Then block-denied-ips at 900, it's "deny" and matches → short-circuits with deny.
		// So blocked IP DOES deny even admin. This is the correct ABAC behavior.
		expect(result.allowed).toBe(false);
		expect(result.matchedPolicy?.id).toBe("block-denied-ips");
	});
});
