import { defineNode } from "@blokjs/runner";
import { z } from "zod";

/**
 * Process-wide key-value store for tests, demos, and small ephemeral state.
 * NOT durable — clears on process restart.
 *
 * Action surface:
 *   get    → returns the value at `key`, or `undefined` if absent
 *   set    → writes `value` at `key`, returns `{ key, value }`
 *   delete → removes the entry, returns `{ key, deleted: boolean }`
 *   list   → returns an array of `{ key, value }` for keys matching `prefix?`
 *   clear  → wipes the store, returns `{ count }` of removed entries
 */
const store = new Map<string, unknown>();

export function _resetInMemoryKvForTests(): void {
	store.clear();
}

const ActionSchema = z.enum(["get", "set", "delete", "list", "clear"]);

export default defineNode({
	name: "@blokjs/in-memory-kv",
	description: "Simple process-wide key-value store for testing and small state. Not durable.",
	input: z.object({
		action: ActionSchema,
		key: z.string().optional(),
		value: z.unknown().optional(),
		prefix: z.string().optional(),
	}),
	output: z.unknown(),

	async execute(_ctx, input) {
		switch (input.action) {
			case "get": {
				if (input.key === undefined) throw new Error("in-memory-kv: `get` requires `key`");
				return { key: input.key, value: store.get(input.key) };
			}
			case "set": {
				if (input.key === undefined) throw new Error("in-memory-kv: `set` requires `key`");
				store.set(input.key, input.value);
				return { key: input.key, value: input.value };
			}
			case "delete": {
				if (input.key === undefined) throw new Error("in-memory-kv: `delete` requires `key`");
				const deleted = store.delete(input.key);
				return { key: input.key, deleted };
			}
			case "list": {
				const entries: { key: string; value: unknown }[] = [];
				for (const [k, v] of store.entries()) {
					if (input.prefix === undefined || k.startsWith(input.prefix)) {
						entries.push({ key: k, value: v });
					}
				}
				return entries;
			}
			case "clear": {
				const count = store.size;
				store.clear();
				return { count };
			}
		}
	},
});
