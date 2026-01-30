import { openai } from "@ai-sdk/openai";
import { type JsonLikeObject, defineNode } from "@nanoservice-ts/runner";
import { generateObject } from "ai";
import { z } from "zod";

export default defineNode({
	name: "dashboard-charts-generator",
	description: "Generates Chart.js configurations for dashboard visualizations using AI",

	input: z.object({
		tables: z.array(z.record(z.unknown())),
		records: z.array(z.record(z.unknown())),
		queries: z.array(z.record(z.unknown())),
		prompt: z.string(),
		set_var: z.boolean().optional(),
	}),

	output: z.object({
		total: z.number(),
		data: z.any(),
	}),

	async execute(_ctx, input) {
		const { tables, records, queries, prompt } = input;

		const system_prompt = `You are an AI assistant specialized in data visualization using Chart.js.
            Given:

            A user prompt describing the visualization needs.
            A table schema detailing the available columns and their data types.
            Queries used to extract relevant data.
            Query results containing rows of data for different charts.
            Your Task:
            Generate a JSON array of chart configuration objects optimized for Chart.js, ensuring the correct mapping of data and chart types.

            Each chart object must follow this structure:

            json
            Copy
            Edit
            {
            "type": "bar" | "line" | "pie" | "doughnut" | "scatter",
            "title": "Descriptive Chart Title",
            "description": "Brief explanation of what the chart represents.",
            "xAxis": "Column name for x-axis (if applicable)",
            "yAxis": "Column name for y-axis (if applicable)",
            "series": [
                { "name": "Label for series", "dataKey": "Column name representing the series data" }
            ],
            "data": []  // Insert the data from the QUERIES
            }
            Guidelines for Chart Selection and Configuration:
            Bar Charts → Use when comparing categories. The x-axis should be categorical data (e.g., product names, months).
            Line Charts → Use for trends over time, ensuring the x-axis is time-based (e.g., dates, years).
            Pie/Doughnut Charts → Use when displaying proportions or percentages from a single categorical variable.
            Scatter Charts → Use when visualizing correlations between two numerical variables.
            If the user prompt specifies a chart type, prioritize that type; otherwise, determine the best fit based on the data.
            Additional Considerations:
            Ensure axis labels are descriptive based on the table schema.
            Preserve column relationships from the query results.
            Include meaningful chart titles and descriptions to enhance readability.
            Avoid redundant or misleading visualizations—only create charts that accurately represent the data.
            Return the response as a well-formatted JSON array of chart configurations.

            Here's the database schema:
			${JSON.stringify(tables, null, 2)}

            Here are the QUERIES:
            ${JSON.stringify(queries, null, 2)}

            WARNING: Be sure to replace the data in the "data" field with the actual data from the QUERIES.
            `;

		const result = await generateObject({
			model: openai("gpt-4o", {
				structuredOutputs: true,
			}),
			schemaName: "queries",
			schemaDescription: "Generate SQL queries for data visualization in a PostgreSQL",
			schema: z.object({
				prompt: z.string(),
				charts: z.array(
					z.object({
						type: z.string().describe("bar | line | pie | doughnut | scatter"),
						title: z.string().describe("Descriptive Chart Title from QUERIES"),
						description: z.string(),
						xAxis: z.string().describe("Column name for x-axis (if applicable)"),
						yAxis: z.string().describe("Column name for y-axis (if applicable)"),
						series: z.array(
							z.object({
								name: z.string().describe("Label for series"),
								dataKey: z.string().describe("Column name representing the series data"),
							}),
						),
						data: z.array(z.object({})).describe("Insert the data from the QUERIES"),
					}),
				),
			}),
			system: system_prompt,
			prompt: prompt,
			temperature: 0.3,
			maxTokens: 1000,
		});

		result.object.charts = result.object.charts.map((charts, index) => {
			return {
				...charts,
				data: (records[index] as unknown as JsonLikeObject).data as unknown as JsonLikeObject[],
			};
		});

		return {
			total: result.object.charts.length,
			data: result.object,
		};
	},
});
