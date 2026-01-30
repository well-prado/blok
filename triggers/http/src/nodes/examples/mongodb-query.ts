import { type JsonLikeObject, defineNode } from "@blok/runner";
import type { Context } from "@blok/shared";
import { MongoClient, ObjectId, type Sort } from "mongodb";
import { z } from "zod";

export default defineNode({
	name: "mongo-query",
	description: "Performs CRUD operations on MongoDB based on HTTP method",

	input: z.object({
		collection: z.string(),
		data: z.record(z.unknown()).optional(),
		id: z.string().optional(),
		limit: z.number().optional(),
		skip: z.number().optional(),
		sort: z.record(z.unknown()).optional(),
		filter: z.record(z.unknown()).optional(),
	}),

	output: z.any(),

	async execute(ctx: Context, input) {
		const client = new MongoClient(process.env.MONGODB_URI as string);

		try {
			await client.connect();
			const db = client.db(process.env.MONGODB_DATABASE);
			const collection = db.collection(input.collection);

			const method = ctx.request.method as unknown as string;

			switch (method) {
				case "POST": {
					if (input.data === undefined) {
						throw new Error("Data is required for POST method");
					}
					const result_post = await collection.insertOne(input.data as JsonLikeObject);
					return {
						insertedId: result_post.insertedId.toString(),
					};
				}
				case "GET": {
					if (input.id !== "undefined") {
						const result = await collection.findOne({
							_id: new ObjectId(input.id),
						});
						return result;
					}
					const result = await collection
						.find(input.filter || {})
						.sort((input.sort as Sort) || {})
						.skip(input.skip || 0)
						.limit(input.limit || 10)
						.toArray();
					return result;
				}
				case "PUT": {
					const result_put = await collection.updateOne(
						{ _id: new ObjectId(input.id as string) },
						{ $set: input.data },
					);
					return { modifiedCount: result_put.modifiedCount };
				}
				case "DELETE": {
					const result = await collection.deleteOne({
						_id: new ObjectId(input.id as string),
					});
					return { deletedCount: result.deletedCount };
				}
				default:
					throw new Error("Invalid HTTP method");
			}
		} finally {
			await client.close();
		}
	},
});
