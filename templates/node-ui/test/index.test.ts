import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import Node from "../index";
import ctx from "./helper";

const rootDir = path.resolve(__dirname, ".");

// Validate Hello World from Node
test("Render index.html page", async () => {
	const response = await Node.handle(ctx(), { react_app: "./dist/app/index.merged.min.js" });
	const mockup_file = path.resolve(rootDir, "index.mockup.html");
	const message: string = fs.readFileSync(mockup_file, "utf8");

	expect(response.success).toEqual(true);
	expect(response.data).toEqual(message);
});
