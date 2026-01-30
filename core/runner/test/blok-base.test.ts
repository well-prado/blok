import type { Context, LoggerContext } from "@blok/shared";
import { beforeAll, expect, test } from "vitest";
import DefaultLogger from "../src/DefaultLogger";
import BlokService from "../src/Blok";
import BlokResponse, { type IBlokResponse } from "../src/BlokResponse";
import type JsonLikeObject from "../src/types/JsonLikeObject";

let context = <Context>{};

type InputType = {
	data: JsonLikeObject;
};

beforeAll(() => {
	context = <Context>{
		response: {},
		request: {},
		vars: {},
		config: {
			"add-property": {
				inputs: {
					data: {
						name: "John Doe",
					},
				},
			},
		} as JsonLikeObject,
		logger: new DefaultLogger() as LoggerContext,
	};
});

test("Execute nanoService implementation", async () => {
	const nano = new AddCreatedAtProperty();
	const response = ((await nano.run(context)) as BlokResponse).data as JsonLikeObject;

	expect(response.success).toBe(true);
	expect(response.data).toHaveProperty("name");
	expect(response.data).toHaveProperty("createdAt");
	expect((response.data as JsonLikeObject).createdAt).toBe(true);
	expect(response.error).toBe(null);
});

test("Execute nanoService wrong inputs", async () => {
	const nano = new AddCreatedAtProperty();
	// @ts-ignore
	context.config["add-property"].inputs.data = undefined;
	try {
		await nano.run(context);
	} catch (e) {
		// @ts-ignore
		expect(e.message).toBe('instance requires property "data"');
	}
});

class AddCreatedAtProperty extends BlokService<InputType> {
	constructor() {
		super();
		this.name = "add-property";
		this.inputSchema = {
			$schema: "http://json-schema.org/draft-07/schema#",
			title: "Generated schema for Root",
			type: "object",
			properties: {
				data: {
					type: "object",
					properties: {},
					required: [],
				},
			},
			required: ["data"],
		};

		this.outputSchema = {
			type: "object",
			properties: {
				createdAt: {},
			},
			additionalProperties: false,
			oneOf: [{ required: ["createdAt"] }],
		};
	}

	public async handle(ctx: Context, inputs: JsonLikeObject): Promise<IBlokResponse | BlokService<InputType>[]> {
		const response = new BlokResponse();
		const data = inputs.data as JsonLikeObject;
		data.createdAt = true;
		response.setSuccess(data);

		return response;
	}
}
