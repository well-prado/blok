/**
 * React Node Tests - Updated for Function-First Implementation
 *
 * Tests migrated from class-based to function-first pattern.
 * All existing behavior is preserved.
 */

import fs from "node:fs";
import path from "node:path";
import type { IBlokResponse } from "@blokjs/runner";
import { beforeAll, expect, test } from "vitest";
import ReactNode from "../index";
import ctx from "./helper";

let rootDir: string;

beforeAll(() => {
	rootDir = path.resolve(__dirname, ".");
});

// Validate React rendering from Node
test("Render index.html page", async () => {
	const context = ctx();
	const inputs = { react_app: "./dist/app/index.merged.min.js" };

	const response = (await ReactNode.handle(context, inputs)) as IBlokResponse;
	const mockup_file = path.resolve(rootDir, "index.mockup.html");
	const message: string = fs.readFileSync(mockup_file, "utf8");

	expect(response.success).toEqual(true);
	expect(response.data).toEqual(message);
});
