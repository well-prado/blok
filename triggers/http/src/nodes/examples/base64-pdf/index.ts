import { defineNode } from "@blok/runner";
import { z } from "zod";

export default defineNode({
	name: "base64-to-pdf",
	description: "Decodes a base64 string into a PDF buffer",
	contentType: "application/pdf",

	input: z.object({
		base64: z.string(),
	}),

	output: z.any(),

	async execute(_ctx, input) {
		return Buffer.from(input.base64, "base64");
	},
});
