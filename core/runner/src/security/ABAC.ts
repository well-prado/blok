/**
 * Attribute-Based Access Control (ABAC) for Blok
 *
 * Provides fine-grained, attribute-driven access control that complements RBAC:
 * - Policies evaluate attributes of subject, resource, action, and environment
 * - Supports logical operators (AND, OR, NOT) for complex conditions
 * - Supports comparison operators (equals, not_equals, in, not_in, contains, matches, gt, lt, gte, lte, between)
 * - Supports attribute-to-attribute comparison via `valueRef` (e.g., resource.owner == subject.sub)
 * - Integrates with AuthIdentity claims and RBAC roles
 * - JSON-serializable policies for persistence and external management
 *
 * @example
 * ```typescript
 * const engine = new ABACEngine();
 *
 * engine.addPolicy({
 *   id: "work-hours-only",
 *   description: "Allow workflow execution only during business hours",
 *   effect: "allow",
 *   target: {
 *     resource: "workflow",
 *     actions: ["execute"],
 *   },
 *   conditions: {
 *     all: [
 *       { attribute: "environment.hour", operator: "gte", value: 9 },
 *       { attribute: "environment.hour", operator: "lt", value: 17 },
 *       { attribute: "subject.department", operator: "equals", value: "engineering" },
 *     ],
 *   },
 * });
 *
 * const result = engine.evaluate({
 *   subject: { sub: "user-1", roles: ["developer"], department: "engineering" },
 *   resource: { type: "workflow", id: "/api/users" },
 *   action: "execute",
 *   environment: { hour: 14, ip: "10.0.0.1" },
 * });
 * ```
 */

// ────────────────────────────── Types ──────────────────────────────

export type ABACOperator =
	| "equals"
	| "not_equals"
	| "in"
	| "not_in"
	| "contains"
	| "not_contains"
	| "matches"
	| "gt"
	| "lt"
	| "gte"
	| "lte"
	| "between"
	| "exists"
	| "not_exists";

export type ABACEffect = "allow" | "deny";

/**
 * A single attribute condition that compares an attribute path against a value.
 *
 * Attribute paths use dot notation to access nested properties:
 * - `subject.department` — the subject's department attribute
 * - `resource.owner` — the resource's owner attribute
 * - `environment.ip` — the environment's IP address
 * - `environment.hour` — the current hour (0-23)
 */
export interface ABACCondition {
	/** Dot-separated path to the attribute (e.g., "subject.department") */
	attribute: string;
	/** Comparison operator */
	operator: ABACOperator;
	/** Static value to compare against (ignored for exists/not_exists operators) */
	value?: unknown;
	/** Attribute path to resolve as the comparison value (attribute-to-attribute comparison).
	 *  When set, `value` is ignored and the comparison value is resolved from the request. */
	valueRef?: string;
}

/**
 * Logical grouping of conditions.
 *
 * - `all`: Every condition must be true (AND)
 * - `any`: At least one condition must be true (OR)
 * - `none`: No condition may be true (NOT / NOR)
 *
 * Groups can be nested for complex logic.
 */
export interface ABACConditionGroup {
	/** All conditions must be true (AND) */
	all?: Array<ABACCondition | ABACConditionGroup>;
	/** At least one condition must be true (OR) */
	any?: Array<ABACCondition | ABACConditionGroup>;
	/** No condition may be true (NOR) */
	none?: Array<ABACCondition | ABACConditionGroup>;
}

/**
 * Policy target restricts which requests the policy applies to.
 */
export interface ABACPolicyTarget {
	/** Resource type (e.g., "workflow", "node", "*") */
	resource?: string;
	/** Resource ID pattern (supports * wildcards) */
	resourcePattern?: string;
	/** Actions this policy applies to */
	actions?: string[];
}

/**
 * An ABAC policy defines conditions under which access is allowed or denied.
 */
export interface ABACPolicy {
	/** Unique policy identifier */
	id: string;
	/** Human-readable description */
	description?: string;
	/** Whether this policy grants or denies access */
	effect: ABACEffect;
	/** Target resource/action scope — if omitted, applies to all requests */
	target?: ABACPolicyTarget;
	/** Conditions that must be satisfied for the policy to apply */
	conditions: ABACConditionGroup;
	/** Priority (higher = evaluated first). Default: 0 */
	priority?: number;
	/** Whether the policy is active. Default: true */
	enabled?: boolean;
}

/**
 * Attributes about the requesting subject (user or service).
 */
export interface SubjectAttributes {
	/** Unique identifier */
	sub: string;
	/** Assigned roles */
	roles?: string[];
	/** Additional attributes (department, clearance, team, etc.) */
	[key: string]: unknown;
}

/**
 * Attributes about the target resource.
 */
export interface ResourceAttributes {
	/** Resource type (workflow, node, trigger, etc.) */
	type: string;
	/** Resource identifier */
	id: string;
	/** Additional attributes (owner, classification, sensitivity, etc.) */
	[key: string]: unknown;
}

/**
 * Attributes about the environment / context.
 */
export interface EnvironmentAttributes {
	/** Additional attributes (ip, hour, dayOfWeek, location, etc.) */
	[key: string]: unknown;
}

/**
 * A complete ABAC evaluation request context.
 */
export interface ABACRequest {
	subject: SubjectAttributes;
	resource: ResourceAttributes;
	action: string;
	environment?: EnvironmentAttributes;
}

/**
 * Result of an ABAC evaluation.
 */
export interface ABACResult {
	/** Whether access is allowed */
	allowed: boolean;
	/** The policy that determined the decision (if any) */
	matchedPolicy?: ABACPolicy;
	/** All policies that were evaluated */
	evaluatedPolicies: Array<{ policyId: string; effect: ABACEffect; matched: boolean }>;
	/** Reason for the decision */
	reason: string;
}

// ────────────────────────────── Engine ──────────────────────────────

export class ABACEngine {
	private policies: Map<string, ABACPolicy> = new Map();
	private defaultEffect: ABACEffect = "deny";

	constructor(options?: { defaultEffect?: ABACEffect }) {
		if (options?.defaultEffect) {
			this.defaultEffect = options.defaultEffect;
		}
	}

	/**
	 * Add or update a policy.
	 */
	addPolicy(policy: ABACPolicy): void {
		this.policies.set(policy.id, policy);
	}

	/**
	 * Remove a policy by ID.
	 */
	removePolicy(id: string): void {
		this.policies.delete(id);
	}

	/**
	 * Get a policy by ID.
	 */
	getPolicy(id: string): ABACPolicy | undefined {
		return this.policies.get(id);
	}

	/**
	 * Get all policies, sorted by priority (highest first).
	 */
	getPolicies(): ABACPolicy[] {
		return Array.from(this.policies.values()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	}

	/**
	 * Evaluate an access request against all policies.
	 *
	 * Policy evaluation order:
	 * 1. Policies are sorted by priority (highest first)
	 * 2. Only enabled policies are considered
	 * 3. Only policies whose target matches the request are considered
	 * 4. The first matching "deny" policy short-circuits with denial
	 * 5. Otherwise, at least one matching "allow" policy is required
	 * 6. If no policy matches, the default effect applies
	 */
	evaluate(request: ABACRequest): ABACResult {
		const sortedPolicies = this.getPolicies();
		const evaluatedPolicies: ABACResult["evaluatedPolicies"] = [];

		let hasAllow = false;
		let allowPolicy: ABACPolicy | undefined;

		for (const policy of sortedPolicies) {
			// Skip disabled policies
			if (policy.enabled === false) continue;

			// Check if policy target matches the request
			if (!this.matchesTarget(policy.target, request)) {
				evaluatedPolicies.push({ policyId: policy.id, effect: policy.effect, matched: false });
				continue;
			}

			// Evaluate conditions
			const conditionsMet = this.evaluateConditionGroup(policy.conditions, request);
			evaluatedPolicies.push({ policyId: policy.id, effect: policy.effect, matched: conditionsMet });

			if (conditionsMet) {
				// Deny takes precedence — short-circuit
				if (policy.effect === "deny") {
					return {
						allowed: false,
						matchedPolicy: policy,
						evaluatedPolicies,
						reason: `Denied by policy '${policy.id}'${policy.description ? `: ${policy.description}` : ""}`,
					};
				}

				// Track the first matching allow
				if (!hasAllow) {
					hasAllow = true;
					allowPolicy = policy;
				}
			}
		}

		if (hasAllow && allowPolicy) {
			return {
				allowed: true,
				matchedPolicy: allowPolicy,
				evaluatedPolicies,
				reason: `Allowed by policy '${allowPolicy.id}'${allowPolicy.description ? `: ${allowPolicy.description}` : ""}`,
			};
		}

		// No matching policy — use default
		const allowed = this.defaultEffect === "allow";
		return {
			allowed,
			evaluatedPolicies,
			reason: allowed ? "No matching policy; default effect is allow" : "No matching policy; default effect is deny",
		};
	}

	/**
	 * Export all policies as JSON.
	 */
	toJSON(): { policies: ABACPolicy[]; defaultEffect: ABACEffect } {
		return {
			policies: Array.from(this.policies.values()),
			defaultEffect: this.defaultEffect,
		};
	}

	/**
	 * Load policies from JSON (replaces all existing policies).
	 */
	fromJSON(config: { policies: ABACPolicy[]; defaultEffect?: ABACEffect }): void {
		this.policies.clear();
		for (const policy of config.policies) {
			this.policies.set(policy.id, policy);
		}
		if (config.defaultEffect) {
			this.defaultEffect = config.defaultEffect;
		}
	}

	// ──────────────────── Target Matching ────────────────────

	private matchesTarget(target: ABACPolicyTarget | undefined, request: ABACRequest): boolean {
		if (!target) return true;

		// Check resource type
		if (target.resource && target.resource !== "*") {
			if (target.resource !== request.resource.type) return false;
		}

		// Check resource pattern
		if (target.resourcePattern) {
			if (!this.matchesPattern(request.resource.id, target.resourcePattern)) return false;
		}

		// Check action
		if (target.actions && target.actions.length > 0) {
			if (!target.actions.includes(request.action) && !target.actions.includes("*")) return false;
		}

		return true;
	}

	// ──────────────────── Condition Evaluation ────────────────────

	private evaluateConditionGroup(group: ABACConditionGroup, request: ABACRequest): boolean {
		// A group with no clauses is treated as "always true"
		const hasAny = group.all || group.any || group.none;
		if (!hasAny) return true;

		// ALL: every item must be true
		if (group.all) {
			for (const item of group.all) {
				if (!this.evaluateItem(item, request)) return false;
			}
		}

		// ANY: at least one must be true
		if (group.any) {
			let anyTrue = false;
			for (const item of group.any) {
				if (this.evaluateItem(item, request)) {
					anyTrue = true;
					break;
				}
			}
			if (!anyTrue) return false;
		}

		// NONE: no item may be true
		if (group.none) {
			for (const item of group.none) {
				if (this.evaluateItem(item, request)) return false;
			}
		}

		return true;
	}

	private evaluateItem(item: ABACCondition | ABACConditionGroup, request: ABACRequest): boolean {
		// Distinguish condition from group: conditions have "attribute"
		if ("attribute" in item) {
			return this.evaluateCondition(item as ABACCondition, request);
		}
		return this.evaluateConditionGroup(item as ABACConditionGroup, request);
	}

	private evaluateCondition(condition: ABACCondition, request: ABACRequest): boolean {
		const attributeValue = this.resolveAttribute(condition.attribute, request);
		// If valueRef is set, resolve the comparison value from another attribute
		const comparisonValue = condition.valueRef ? this.resolveAttribute(condition.valueRef, request) : condition.value;
		return this.compare(attributeValue, condition.operator, comparisonValue);
	}

	// ──────────────────── Attribute Resolution ────────────────────

	private resolveAttribute(path: string, request: ABACRequest): unknown {
		const segments = path.split(".");
		if (segments.length === 0) return undefined;

		const root = segments[0];
		const rest = segments.slice(1);

		let obj: unknown;
		switch (root) {
			case "subject":
				obj = request.subject;
				break;
			case "resource":
				obj = request.resource;
				break;
			case "action":
				// "action" with no sub-path resolves to the action string itself
				return rest.length === 0 ? request.action : undefined;
			case "environment":
				obj = request.environment;
				break;
			default:
				return undefined;
		}

		// Traverse the rest of the path
		for (const segment of rest) {
			if (obj === null || obj === undefined) return undefined;
			if (typeof obj === "object") {
				obj = (obj as Record<string, unknown>)[segment];
			} else {
				return undefined;
			}
		}

		return obj;
	}

	// ──────────────────── Comparison Operators ────────────────────

	private compare(actual: unknown, operator: ABACOperator, expected: unknown): boolean {
		switch (operator) {
			case "equals":
				return actual === expected;

			case "not_equals":
				return actual !== expected;

			case "in":
				return Array.isArray(expected) && expected.includes(actual);

			case "not_in":
				return Array.isArray(expected) && !expected.includes(actual);

			case "contains":
				if (Array.isArray(actual)) return actual.includes(expected);
				if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
				return false;

			case "not_contains":
				if (Array.isArray(actual)) return !actual.includes(expected);
				if (typeof actual === "string" && typeof expected === "string") return !actual.includes(expected);
				return true;

			case "matches":
				if (typeof actual !== "string" || typeof expected !== "string") return false;
				try {
					return new RegExp(expected).test(actual);
				} catch {
					return false;
				}

			case "gt":
				return typeof actual === "number" && typeof expected === "number" && actual > expected;

			case "lt":
				return typeof actual === "number" && typeof expected === "number" && actual < expected;

			case "gte":
				return typeof actual === "number" && typeof expected === "number" && actual >= expected;

			case "lte":
				return typeof actual === "number" && typeof expected === "number" && actual <= expected;

			case "between": {
				if (typeof actual !== "number") return false;
				if (!Array.isArray(expected) || expected.length !== 2) return false;
				const [low, high] = expected as [number, number];
				return typeof low === "number" && typeof high === "number" && actual >= low && actual <= high;
			}

			case "exists":
				return actual !== undefined && actual !== null;

			case "not_exists":
				return actual === undefined || actual === null;

			default:
				return false;
		}
	}

	// ──────────────────── Utility ────────────────────

	private matchesPattern(value: string, pattern: string): boolean {
		if (pattern === "*") return true;
		const regexStr = pattern.replace(/\*/g, ".*").replace(/\?/g, ".");
		const regex = new RegExp(`^${regexStr}$`);
		return regex.test(value);
	}
}

/**
 * Create a preconfigured ABAC engine with common policies.
 */
export function createDefaultABAC(): ABACEngine {
	const engine = new ABACEngine();

	// Policy: Admin override — admins always get access
	engine.addPolicy({
		id: "admin-override",
		description: "Admin role bypasses all attribute checks",
		effect: "allow",
		priority: 1000,
		conditions: {
			any: [{ attribute: "subject.roles", operator: "contains", value: "admin" }],
		},
	});

	// Policy: Deny access from blocked IPs
	engine.addPolicy({
		id: "block-denied-ips",
		description: "Deny access from blocked IP ranges",
		effect: "deny",
		priority: 900,
		conditions: {
			any: [{ attribute: "environment.blocked", operator: "equals", value: true }],
		},
	});

	// Policy: Allow service accounts to execute workflows
	engine.addPolicy({
		id: "service-execute",
		description: "Service accounts can execute workflows",
		effect: "allow",
		priority: 100,
		target: {
			resource: "workflow",
			actions: ["execute"],
		},
		conditions: {
			all: [{ attribute: "subject.roles", operator: "contains", value: "service" }],
		},
	});

	// Policy: Resource owner full access (attribute-to-attribute comparison)
	engine.addPolicy({
		id: "resource-owner-access",
		description: "Resource owners have full access to their resources",
		effect: "allow",
		priority: 500,
		conditions: {
			all: [
				{ attribute: "resource.owner", operator: "exists" },
				{ attribute: "resource.owner", operator: "equals", valueRef: "subject.sub" },
			],
		},
	});

	return engine;
}
