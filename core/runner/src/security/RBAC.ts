/**
 * Role-Based Access Control (RBAC) for Blok
 *
 * Provides fine-grained access control for workflow execution:
 * - Role definitions with permissions
 * - Resource-based access control
 * - Hierarchical roles with inheritance
 * - Workflow-level and node-level access control
 *
 * @example
 * ```typescript
 * const rbac = new RBAC();
 *
 * // Define roles
 * rbac.addRole({
 *   name: "admin",
 *   permissions: [
 *     { resource: "workflow", actions: ["*"] },
 *     { resource: "node", actions: ["*"] },
 *   ],
 * });
 *
 * rbac.addRole({
 *   name: "developer",
 *   permissions: [
 *     { resource: "workflow", actions: ["read", "execute"] },
 *     { resource: "node", actions: ["read", "execute"] },
 *   ],
 *   inherits: ["viewer"],
 * });
 *
 * rbac.addRole({
 *   name: "viewer",
 *   permissions: [
 *     { resource: "workflow", actions: ["read"] },
 *   ],
 * });
 *
 * // Check permissions
 * rbac.can("admin", "workflow", "delete");     // true
 * rbac.can("developer", "workflow", "execute"); // true
 * rbac.can("viewer", "workflow", "execute");    // false
 * ```
 */

export type Action = "read" | "create" | "update" | "delete" | "execute" | "admin" | "*";

export interface Permission {
	/** Resource type (e.g., "workflow", "node", "trigger", "runtime") */
	resource: string;
	/** Allowed actions on this resource */
	actions: Action[];
	/** Optional: restrict to specific resource instances by pattern */
	resourcePattern?: string;
	/** Optional: conditions that must be met (e.g., { "env": "staging" }) */
	conditions?: Record<string, unknown>;
}

export interface RoleDefinition {
	/** Unique role name */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Permissions granted to this role */
	permissions: Permission[];
	/** Roles this role inherits from */
	inherits?: string[];
}

export interface AccessCheckResult {
	allowed: boolean;
	role: string;
	resource: string;
	action: Action;
	reason?: string;
	matchedPermission?: Permission;
}

export interface RBACPolicy {
	/** Named resource access policies */
	workflows?: Record<string, { allowedRoles: string[]; actions?: Action[] }>;
	/** Default policy when no specific policy matches */
	defaultPolicy?: "allow" | "deny";
}

export class RBAC {
	private roles: Map<string, RoleDefinition> = new Map();
	private policies: Map<string, RBACPolicy> = new Map();
	private roleCache: Map<string, Permission[]> = new Map();

	/**
	 * Add a role definition
	 */
	addRole(role: RoleDefinition): void {
		this.roles.set(role.name, role);
		// Invalidate cache for this role and any role that inherits from it
		this.roleCache.clear();
	}

	/**
	 * Remove a role
	 */
	removeRole(name: string): void {
		this.roles.delete(name);
		this.roleCache.clear();
	}

	/**
	 * Get a role definition
	 */
	getRole(name: string): RoleDefinition | undefined {
		return this.roles.get(name);
	}

	/**
	 * Get all defined roles
	 */
	getRoles(): RoleDefinition[] {
		return Array.from(this.roles.values());
	}

	/**
	 * Add a resource-specific policy
	 */
	addPolicy(resourceId: string, policy: RBACPolicy): void {
		this.policies.set(resourceId, policy);
	}

	/**
	 * Check if a role has permission to perform an action on a resource
	 */
	can(roleName: string, resource: string, action: Action, resourceId?: string): AccessCheckResult {
		const permissions = this.getEffectivePermissions(roleName);

		for (const perm of permissions) {
			if (this.matchesPermission(perm, resource, action, resourceId)) {
				return {
					allowed: true,
					role: roleName,
					resource,
					action,
					matchedPermission: perm,
				};
			}
		}

		return {
			allowed: false,
			role: roleName,
			resource,
			action,
			reason: `Role '${roleName}' does not have '${action}' permission on '${resource}'`,
		};
	}

	/**
	 * Check if any of the given roles has permission
	 */
	canAny(roles: string[], resource: string, action: Action, resourceId?: string): AccessCheckResult {
		for (const role of roles) {
			const result = this.can(role, resource, action, resourceId);
			if (result.allowed) return result;
		}

		return {
			allowed: false,
			role: roles.join(","),
			resource,
			action,
			reason: `None of roles [${roles.join(", ")}] have '${action}' permission on '${resource}'`,
		};
	}

	/**
	 * Check workflow-specific access
	 */
	canAccessWorkflow(roles: string[], workflowPath: string, action: Action = "execute"): AccessCheckResult {
		// Check resource-specific policy first
		const policy = this.policies.get(workflowPath);
		if (policy?.workflows) {
			for (const [pattern, config] of Object.entries(policy.workflows)) {
				if (this.matchesPattern(workflowPath, pattern)) {
					const allowedActions = config.actions || ["execute"];
					if (!allowedActions.includes(action) && !allowedActions.includes("*")) {
						return {
							allowed: false,
							role: roles.join(","),
							resource: workflowPath,
							action,
							reason: `Action '${action}' not allowed on workflow '${workflowPath}'`,
						};
					}

					const hasAllowedRole = roles.some((r) => config.allowedRoles.includes(r));
					if (hasAllowedRole) {
						return {
							allowed: true,
							role: roles.find((r) => config.allowedRoles.includes(r)) || roles[0],
							resource: workflowPath,
							action,
						};
					}
				}
			}
		}

		// Fall back to general RBAC check
		return this.canAny(roles, "workflow", action, workflowPath);
	}

	/**
	 * Get all effective permissions for a role (including inherited)
	 */
	getEffectivePermissions(roleName: string, visited: Set<string> = new Set()): Permission[] {
		// Check cache
		const cached = this.roleCache.get(roleName);
		if (cached) return cached;

		// Guard against circular inheritance
		if (visited.has(roleName)) return [];
		visited.add(roleName);

		const role = this.roles.get(roleName);
		if (!role) return [];

		const permissions = [...role.permissions];

		// Resolve inherited permissions
		if (role.inherits) {
			for (const parentRole of role.inherits) {
				const inherited = this.getEffectivePermissions(parentRole, visited);
				permissions.push(...inherited);
			}
		}

		// Cache results
		this.roleCache.set(roleName, permissions);
		return permissions;
	}

	/**
	 * Export current RBAC configuration as JSON
	 */
	toJSON(): { roles: RoleDefinition[]; policies: Record<string, RBACPolicy> } {
		return {
			roles: Array.from(this.roles.values()),
			policies: Object.fromEntries(this.policies),
		};
	}

	/**
	 * Load RBAC configuration from JSON
	 */
	fromJSON(config: { roles: RoleDefinition[]; policies?: Record<string, RBACPolicy> }): void {
		this.roles.clear();
		this.policies.clear();
		this.roleCache.clear();

		for (const role of config.roles) {
			this.addRole(role);
		}

		if (config.policies) {
			for (const [id, policy] of Object.entries(config.policies)) {
				this.addPolicy(id, policy);
			}
		}
	}

	private matchesPermission(perm: Permission, resource: string, action: Action, resourceId?: string): boolean {
		// Check resource type
		if (perm.resource !== resource && perm.resource !== "*") return false;

		// Check action
		if (!perm.actions.includes(action) && !perm.actions.includes("*")) return false;

		// Check resource pattern if specified
		if (perm.resourcePattern && resourceId) {
			if (!this.matchesPattern(resourceId, perm.resourcePattern)) return false;
		}

		return true;
	}

	private matchesPattern(value: string, pattern: string): boolean {
		// Support wildcards: "workflow/*", "workflow/user-*"
		if (pattern === "*") return true;

		const regexStr = pattern.replace(/\*/g, ".*").replace(/\?/g, ".");
		const regex = new RegExp(`^${regexStr}$`);
		return regex.test(value);
	}
}

/**
 * Create a preconfigured RBAC instance with common roles
 */
export function createDefaultRBAC(): RBAC {
	const rbac = new RBAC();

	rbac.addRole({
		name: "admin",
		description: "Full access to all resources",
		permissions: [{ resource: "*", actions: ["*"] }],
	});

	rbac.addRole({
		name: "developer",
		description: "Can read, create, and execute workflows and nodes",
		permissions: [
			{ resource: "workflow", actions: ["read", "create", "update", "execute"] },
			{ resource: "node", actions: ["read", "create", "update", "execute"] },
			{ resource: "trigger", actions: ["read"] },
			{ resource: "runtime", actions: ["read", "execute"] },
		],
		inherits: ["viewer"],
	});

	rbac.addRole({
		name: "operator",
		description: "Can execute and monitor workflows",
		permissions: [
			{ resource: "workflow", actions: ["read", "execute"] },
			{ resource: "node", actions: ["read", "execute"] },
			{ resource: "trigger", actions: ["read"] },
			{ resource: "runtime", actions: ["read"] },
			{ resource: "metrics", actions: ["read"] },
			{ resource: "health", actions: ["read"] },
		],
	});

	rbac.addRole({
		name: "viewer",
		description: "Read-only access to workflows and nodes",
		permissions: [
			{ resource: "workflow", actions: ["read"] },
			{ resource: "node", actions: ["read"] },
			{ resource: "metrics", actions: ["read"] },
			{ resource: "health", actions: ["read"] },
		],
	});

	rbac.addRole({
		name: "service",
		description: "Machine-to-machine service account",
		permissions: [
			{ resource: "workflow", actions: ["execute"] },
			{ resource: "node", actions: ["execute"] },
		],
	});

	return rbac;
}
