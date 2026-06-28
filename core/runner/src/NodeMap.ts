import type { NodeBase } from "@blokjs/shared";

export default class NodeMap {
	public nodes: Map<string, NodeBase> = new Map<string, NodeBase>();

	/**
	 * Register a node under its `use:` key.
	 *
	 * Throws on a CONFLICT — a *different* node already registered under the
	 * same key. Silent last-wins shadowing is a security risk: a user node
	 * could overwrite a built-in like `@blokjs/jwt-verify` and bypass auth with
	 * no warning. Re-registering the SAME instance is idempotent (a no-op); an
	 * intentional override passes `{ replace: true }` (HMR, test stubs).
	 *
	 * This is the collision guard the import-registration / auto-discovery work
	 * (#349) builds on — once nodes register individually instead of via a
	 * pre-deduped object spread, conflicts surface loudly instead of vanishing.
	 */
	public addNode(name: string, node: NodeBase, opts?: { replace?: boolean }): void {
		const existing = this.nodes.get(name);
		if (existing && existing !== node && !opts?.replace) {
			throw new Error(
				`Node registration conflict: "${name}" is already registered to a different node. Two nodes must not claim the same \`use:\` key — silent last-wins shadowing is a security risk (a user node could shadow a built-in like @blokjs/jwt-verify). Rename one node, or pass { replace: true } for an intentional override.`,
			);
		}
		this.nodes.set(name, node);
	}

	public getNode(name: string): NodeBase | undefined {
		return this.nodes.get(name);
	}

	public getNodes(): Map<string, NodeBase> {
		return this.nodes;
	}
}
