import { createOpenAI } from "@ai-sdk/openai";
import { defineNode } from "@blok/runner";
import type { Context } from "@blok/shared";
import type ParamsDictionary from "@blok/shared/dist/types/ParamsDictionary";
import { generateText } from "ai";
import { z } from "zod";

export default defineNode({
	name: "query-generator",
	description: "Generates SQL queries using OpenAI based on table schema and prompt",

	input: z.object({
		table_name: z.string(),
		columns: z.array(
			z.object({
				column_name: z.string(),
				data_type: z.string(),
				primary_key: z.string(),
			}),
		),
		prompt: z.string().optional(),
	}),

	output: z.object({
		query: z.string(),
	}),

	async execute(ctx: Context, input) {
		const { table_name: tableName, columns, prompt } = input;

		// Format column information
		const tableSchema = columns
			.map(
				(col) => `${col.column_name} (${col.data_type}${col.column_name === col.primary_key ? ", PRIMARY KEY" : ""})`,
			)
			.join(", ");

		// Generate SQL query using AI
		const openai = createOpenAI({
			compatibility: "strict",
			apiKey: process.env.OPENAI_API_KEY,
		});

		const ai_prompt = `Table: ${tableName}
				 Schema: ${tableSchema}

				 Generate a SQL query for the following request: ${prompt}

				 Return ONLY the SQL query with no explanations, additional text or markdown code group.

				 Double check the query to not include markdown code blocks or any other text that is not a valid SQL query.`;

		const { text: sqlQuery } = await generateText({
			model: openai("gpt-4o"),
			system: `You are a SQL expert. Generate only valid SQL queries without any explanations or markdown.
				 The query should be executable directly against a PostgreSQL database.`,
			prompt: ai_prompt,
		});

		if (ctx.vars === undefined) ctx.vars = {};
		ctx.vars.query = sqlQuery as unknown as ParamsDictionary;

		return { query: sqlQuery };
	},
});
