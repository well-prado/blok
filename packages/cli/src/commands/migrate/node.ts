import path from "node:path";
import * as p from "@clack/prompts";
import type { OptionValues } from "commander";
import fsExtra from "fs-extra";
import color from "picocolors";

/**
 * Migration guide for converting class-based nodes to function-first
 */
export async function migrateNode(opts: OptionValues) {
	console.log(color.cyan("\n🔄 Node Migration Tool"));
	console.log(color.dim("Converts class-based nodes to function-first pattern\n"));

	const nodePath = opts.path as string | undefined;

	if (!nodePath) {
		p.cancel("Error: Please provide a node path using --path");
		process.exit(1);
	}

	const s = p.spinner();
	s.start("Analyzing node...");

	try {
		// Validate the file exists
		const absolutePath = path.isAbsolute(nodePath) ? nodePath : path.resolve(process.cwd(), nodePath);

		if (!fsExtra.existsSync(absolutePath)) {
			s.stop("Error: File not found");
			console.log(color.red(`\n❌ File not found: ${absolutePath}`));
			process.exit(1);
		}

		// Read the file content
		const fileContent = fsExtra.readFileSync(absolutePath, "utf8");

		// Check if it's already using defineNode
		if (fileContent.includes("defineNode")) {
			s.stop("Already using function-first pattern");
			console.log(color.yellow("\n⚠️  This node is already using the function-first pattern!"));
			console.log(color.dim("No migration needed.\n"));
			process.exit(0);
		}

		// Check if it's a class-based node
		if (!fileContent.includes("extends NanoService")) {
			s.stop("Not a class-based node");
			console.log(color.red("\n❌ This doesn't appear to be a class-based NanoService node."));
			console.log(color.dim("Migration is only supported for nodes extending NanoService.\n"));
			process.exit(1);
		}

		s.stop("Node analyzed");

		// Show migration guide
		console.log(color.green("\n✅ This is a class-based node that can be migrated!"));
		console.log("\n" + color.bold("Migration Steps:") + "\n");
		console.log("1. " + color.cyan("Backup your current file:"));
		console.log(color.dim(`   cp ${nodePath} ${nodePath}.backup`));
		console.log("\n2. " + color.cyan("Follow the migration guide:"));
		console.log(color.dim("   https://github.com/yourrepo/blok/blob/main/MIGRATION_GUIDE.md"));
		console.log("\n3. " + color.cyan("Key changes needed:"));
		console.log(color.dim("   • Replace class with defineNode()"));
		console.log(color.dim("   • Convert JSON Schema to Zod schemas"));
		console.log(color.dim("   • Move handle() logic to execute()"));
		console.log(color.dim("   • Remove NanoServiceResponse boilerplate"));
		console.log(color.dim("   • Return plain objects instead of response.setSuccess()"));
		console.log("\n4. " + color.cyan("Example transformation:"));

		// Show example
		console.log(color.dim("\n   Before (class-based):"));
		console.log(
			color.dim(`
   export default class MyNode extends NanoService<InputType> {
     async handle(ctx: Context, inputs: InputType) {
       const response = new NanoServiceResponse();
       try {
         const result = await doSomething(inputs.value);
         response.setSuccess({ result });
       } catch (error) {
         const nodeError = new GlobalError(error.message);
         response.setError(nodeError);
       }
       return response;
     }
   }`),
		);

		console.log(color.dim("\n   After (function-first):"));
		console.log(
			color.dim(`
   export default defineNode({
     name: "my-node",
     input: z.object({ value: z.string() }),
     output: z.object({ result: z.string() }),
     async execute(ctx, input) {
       const result = await doSomething(input.value);
       return { result };
     }
   });`),
		);

		console.log("\n5. " + color.cyan("Test your migrated node:"));
		console.log(color.dim("   • Run existing tests to verify behavior"));
		console.log(color.dim("   • Check that input/output validation works"));
		console.log(color.dim("   • Verify error handling is correct"));

		console.log("\n6. " + color.cyan("Resources:"));
		console.log(color.dim("   • Full Migration Guide: MIGRATION_GUIDE.md"));
		console.log(color.dim("   • defineNode API Docs: core/runner/FUNCTION_FIRST_NODES.md"));
		console.log(color.dim("   • Example Nodes: core/runner/examples/function-first/"));

		// Ask if user wants to create a backup
		const shouldBackup = await p.confirm({
			message: "Would you like to create a backup of this file now?",
			initialValue: true,
		});

		if (shouldBackup) {
			const backupPath = `${absolutePath}.backup`;
			fsExtra.copyFileSync(absolutePath, backupPath);
			console.log(color.green(`\n✅ Backup created: ${backupPath}`));
		}

		console.log(
			color.cyan("\n💡 Tip:") +
				color.dim(" Start by migrating one node as a reference, then use it as a template for others.\n"),
		);
	} catch (error) {
		s.stop("Error occurred");
		console.log(color.red(`\n❌ Error: ${(error as Error).message}\n`));
		process.exit(1);
	}
}
