import { expect, test } from "vitest";
import Node from "../index";
import ctx from "./helper";

// Validate Hello World from Node
test("Hello World from Node", async () => {
	const response = await Node.handle(ctx(), {});
	const message = { message: "Hello World from Node!" };

	expect(message).toEqual(response.data);
});
