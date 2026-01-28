import { describe, expect, it } from "vitest";
import { RBAC, createDefaultRBAC } from "../../security/RBAC";

describe("RBAC", () => {
	it("should add and retrieve roles", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "admin",
			permissions: [{ resource: "*", actions: ["*"] }],
		});

		const role = rbac.getRole("admin");
		expect(role).toBeDefined();
		expect(role?.name).toBe("admin");
	});

	it("should grant wildcard permissions", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "admin",
			permissions: [{ resource: "*", actions: ["*"] }],
		});

		expect(rbac.can("admin", "workflow", "execute").allowed).toBe(true);
		expect(rbac.can("admin", "node", "delete").allowed).toBe(true);
		expect(rbac.can("admin", "trigger", "admin").allowed).toBe(true);
	});

	it("should deny access for unknown roles", () => {
		const rbac = new RBAC();
		const result = rbac.can("nonexistent", "workflow", "execute");
		expect(result.allowed).toBe(false);
	});

	it("should enforce specific permissions", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "viewer",
			permissions: [{ resource: "workflow", actions: ["read"] }],
		});

		expect(rbac.can("viewer", "workflow", "read").allowed).toBe(true);
		expect(rbac.can("viewer", "workflow", "execute").allowed).toBe(false);
		expect(rbac.can("viewer", "workflow", "delete").allowed).toBe(false);
		expect(rbac.can("viewer", "node", "read").allowed).toBe(false);
	});

	it("should support role inheritance", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "viewer",
			permissions: [{ resource: "workflow", actions: ["read"] }],
		});
		rbac.addRole({
			name: "developer",
			permissions: [{ resource: "workflow", actions: ["execute"] }],
			inherits: ["viewer"],
		});

		// Developer should have own + inherited permissions
		expect(rbac.can("developer", "workflow", "execute").allowed).toBe(true);
		expect(rbac.can("developer", "workflow", "read").allowed).toBe(true);
		// But not permissions not in either role
		expect(rbac.can("developer", "workflow", "delete").allowed).toBe(false);
	});

	it("should handle deep role inheritance", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "base",
			permissions: [{ resource: "health", actions: ["read"] }],
		});
		rbac.addRole({
			name: "viewer",
			permissions: [{ resource: "workflow", actions: ["read"] }],
			inherits: ["base"],
		});
		rbac.addRole({
			name: "developer",
			permissions: [{ resource: "workflow", actions: ["execute"] }],
			inherits: ["viewer"],
		});

		expect(rbac.can("developer", "health", "read").allowed).toBe(true);
		expect(rbac.can("developer", "workflow", "read").allowed).toBe(true);
		expect(rbac.can("developer", "workflow", "execute").allowed).toBe(true);
	});

	it("should handle circular inheritance gracefully", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "a",
			permissions: [{ resource: "x", actions: ["read"] }],
			inherits: ["b"],
		});
		rbac.addRole({
			name: "b",
			permissions: [{ resource: "y", actions: ["read"] }],
			inherits: ["a"],
		});

		// Should not infinite loop
		const result = rbac.can("a", "x", "read");
		expect(result.allowed).toBe(true);
	});

	it("should check any role with canAny", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "viewer",
			permissions: [{ resource: "workflow", actions: ["read"] }],
		});
		rbac.addRole({
			name: "executor",
			permissions: [{ resource: "workflow", actions: ["execute"] }],
		});

		const result = rbac.canAny(["viewer", "executor"], "workflow", "execute");
		expect(result.allowed).toBe(true);
		expect(result.role).toBe("executor");

		const denied = rbac.canAny(["viewer"], "workflow", "execute");
		expect(denied.allowed).toBe(false);
	});

	it("should check workflow access with canAccessWorkflow", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "admin",
			permissions: [{ resource: "workflow", actions: ["*"] }],
		});

		const result = rbac.canAccessWorkflow(["admin"], "/users/create", "execute");
		expect(result.allowed).toBe(true);
	});

	it("should support resource-specific policies", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "viewer",
			permissions: [{ resource: "workflow", actions: ["read"] }],
		});

		rbac.addPolicy("/users/create", {
			workflows: {
				"/users/create": {
					allowedRoles: ["viewer"],
					actions: ["execute"],
				},
			},
		});

		const result = rbac.canAccessWorkflow(["viewer"], "/users/create", "execute");
		expect(result.allowed).toBe(true);
	});

	it("should remove roles", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "temp",
			permissions: [{ resource: "workflow", actions: ["read"] }],
		});

		expect(rbac.getRole("temp")).toBeDefined();
		rbac.removeRole("temp");
		expect(rbac.getRole("temp")).toBeUndefined();
	});

	it("should list all roles", () => {
		const rbac = new RBAC();
		rbac.addRole({ name: "a", permissions: [] });
		rbac.addRole({ name: "b", permissions: [] });
		rbac.addRole({ name: "c", permissions: [] });

		const roles = rbac.getRoles();
		expect(roles.length).toBe(3);
		expect(roles.map((r) => r.name)).toEqual(["a", "b", "c"]);
	});

	it("should support resource pattern matching", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "user-admin",
			permissions: [{
				resource: "workflow",
				actions: ["execute"],
				resourcePattern: "user-*",
			}],
		});

		expect(rbac.can("user-admin", "workflow", "execute", "user-create").allowed).toBe(true);
		expect(rbac.can("user-admin", "workflow", "execute", "user-delete").allowed).toBe(true);
		expect(rbac.can("user-admin", "workflow", "execute", "order-create").allowed).toBe(false);
	});

	it("should export/import JSON config", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "admin",
			permissions: [{ resource: "*", actions: ["*"] }],
		});
		rbac.addRole({
			name: "viewer",
			permissions: [{ resource: "workflow", actions: ["read"] }],
		});

		const json = rbac.toJSON();
		expect(json.roles.length).toBe(2);

		const rbac2 = new RBAC();
		rbac2.fromJSON(json);
		expect(rbac2.can("admin", "workflow", "execute").allowed).toBe(true);
		expect(rbac2.can("viewer", "workflow", "read").allowed).toBe(true);
	});

	it("should provide reason on denial", () => {
		const rbac = new RBAC();
		rbac.addRole({
			name: "viewer",
			permissions: [{ resource: "workflow", actions: ["read"] }],
		});

		const result = rbac.can("viewer", "workflow", "execute");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("viewer");
		expect(result.reason).toContain("execute");
		expect(result.reason).toContain("workflow");
	});
});

describe("createDefaultRBAC", () => {
	it("should create RBAC with predefined roles", () => {
		const rbac = createDefaultRBAC();

		const roles = rbac.getRoles();
		expect(roles.length).toBe(5);
		expect(roles.map((r) => r.name)).toContain("admin");
		expect(roles.map((r) => r.name)).toContain("developer");
		expect(roles.map((r) => r.name)).toContain("operator");
		expect(roles.map((r) => r.name)).toContain("viewer");
		expect(roles.map((r) => r.name)).toContain("service");
	});

	it("should grant admin full access", () => {
		const rbac = createDefaultRBAC();
		expect(rbac.can("admin", "workflow", "delete").allowed).toBe(true);
		expect(rbac.can("admin", "node", "admin").allowed).toBe(true);
	});

	it("should restrict viewer to read-only", () => {
		const rbac = createDefaultRBAC();
		expect(rbac.can("viewer", "workflow", "read").allowed).toBe(true);
		expect(rbac.can("viewer", "workflow", "execute").allowed).toBe(false);
		expect(rbac.can("viewer", "workflow", "delete").allowed).toBe(false);
	});

	it("should allow developer to execute workflows", () => {
		const rbac = createDefaultRBAC();
		expect(rbac.can("developer", "workflow", "execute").allowed).toBe(true);
		expect(rbac.can("developer", "workflow", "read").allowed).toBe(true);
		expect(rbac.can("developer", "workflow", "delete").allowed).toBe(false);
	});

	it("should allow operator to monitor", () => {
		const rbac = createDefaultRBAC();
		expect(rbac.can("operator", "metrics", "read").allowed).toBe(true);
		expect(rbac.can("operator", "health", "read").allowed).toBe(true);
		expect(rbac.can("operator", "workflow", "execute").allowed).toBe(true);
	});

	it("should restrict service to execution only", () => {
		const rbac = createDefaultRBAC();
		expect(rbac.can("service", "workflow", "execute").allowed).toBe(true);
		expect(rbac.can("service", "workflow", "read").allowed).toBe(false);
	});
});
