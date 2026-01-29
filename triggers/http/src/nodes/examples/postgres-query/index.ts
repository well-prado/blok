import { defineNode } from "@nanoservice-ts/runner";
import pg from "pg";
import { z } from "zod";

type Table = {
	total: number;
	data: unknown[];
};

export default defineNode({
	name: "postgres-query",
	description: "Executes SQL queries against a PostgreSQL database",

	input: z.object({
		user: z.string(),
		password: z.string(),
		host: z.string(),
		query: z.string(),
		set_var: z.boolean().optional(),
	}),

	output: z.any(),

	async execute(_ctx, input) {
		const { Client } = pg;
		const client = new Client({
			user: input.user,
			password: input.password,
			host: input.host,
			port: 5432,
			database: "dvdrental",
		});

		try {
			await client.connect();
			const result = await client.query(input.query);
			await client.end();

			if (Array.isArray(result)) {
				const tables: Table[] = [];

				for (let i = 0; i < result.length; i++) {
					const data = result[i];
					const table: Table = {
						total: data.rows.length,
						data: [...data.rows],
					};
					tables.push(table);
				}

				return tables;
			}

			return {
				total: result.rowCount as number,
				data: result.rows,
			};
		} catch (error: unknown) {
			// Preserve AggregateError handling from original implementation
			let message = (error as Error).message;
			if (error instanceof AggregateError)
				message = (error as AggregateError).errors[0];
			throw new Error(message);
		}
	},
});
