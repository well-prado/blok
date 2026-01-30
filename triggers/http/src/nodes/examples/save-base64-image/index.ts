import fs from "node:fs";
import path from "node:path";
import { defineNode } from "@nanoservice-ts/runner";
import { z } from "zod";

export default defineNode({
	name: "save-image-base64",
	description: "Saves a base64-encoded image to disk",

	input: z.object({
		base64: z.string(),
		dir_path: z.string().optional(),
	}),

	output: z.object({
		local_path: z.string(),
		url_path: z.string(),
	}),

	async execute(_ctx, input) {
		const { base64: base64Image, dir_path } = input;

		const timestamp = Date.now();
		const randomString = Math.random().toString(36).substring(2, 8);
		const fileName = `img_${timestamp}_${randomString}`;

		const outputPath = `${dir_path}/images/examples`;

		if (!fs.existsSync(outputPath)) {
			fs.mkdirSync(outputPath, { recursive: true });
		}

		let base64Data = base64Image;
		let imageExtension = "png";

		if (base64Image.includes(";base64,")) {
			const matches = base64Image.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
			if (matches && matches.length === 3) {
				imageExtension = matches[1];
				base64Data = matches[2];
			} else {
				base64Data = base64Image.split(";base64,").pop() as string;
			}
		}

		const buffer = Buffer.from(base64Data, "base64");
		const fullFilePath = path.join(outputPath, `${fileName}.${imageExtension}`);

		fs.writeFileSync(fullFilePath, buffer);

		return {
			local_path: fullFilePath,
			url_path: `/images/examples/${fileName}.${imageExtension}`,
		};
	},
});
