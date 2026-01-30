import { type JsonLikeObject, defineNode } from "@blok/runner";
import type { Context } from "@blok/shared";
import { z } from "zod";
import InMemory from "./InMemory";

export default defineNode({
	name: "memory-storage",
	description: "In-memory key-value storage with get, set, delete, and clear operations",

	input: z.object({
		action: z.enum(["get", "get-all", "set", "delete", "clear"]),
		key: z.string().optional(),
		value: z.record(z.unknown()).optional(),
	}),

	output: z.any(),

	async execute(ctx: Context, input) {
		const cache = InMemory.getInstance();

		switch (input.action) {
			case "get":
				return cache.get(input.key as string);
			case "get-all":
				return cache.getAll();
			case "set":
				cache.set(input.key as string, input.value as JsonLikeObject);
				return input.value;
			case "delete":
				cache.delete(input.key as string);
				return ctx.response.data;
			case "clear":
				cache.clear();
				return ctx.response.data;
		}
	},
});
