import child_process from "node:child_process";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import * as p from "@clack/prompts";
import type { OptionValues } from "commander";
import figlet from "figlet";
import fsExtra from "fs-extra";
import color from "picocolors";
import { manager as pm } from "../../services/package-manager.js";
import {
	csharp_csproj_file,
	csharp_dockerfile,
	csharp_node_file,
	function_first_node_file,
	go_dockerfile,
	go_mod_file,
	go_node_file,
	java_dockerfile,
	java_node_file,
	java_pom_file,
	php_composer_file,
	php_dockerfile,
	php_node_file,
	python3_file,
	ruby_dockerfile,
	ruby_gemfile,
	ruby_node_file,
	rust_cargo_file,
	rust_dockerfile,
	rust_node_file,
} from "./utils/Examples.js";

const exec = util.promisify(child_process.exec);

const HOME_DIR = `${os.homedir()}/.nanoctl`;

/** Convert kebab-case to PascalCase (e.g. "my-node" -> "MyNode") */
function toPascalCase(name: string): string {
	return name
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}
const GITHUB_REPO_LOCAL = `${HOME_DIR}/blok`;

export async function createNode(opts: OptionValues, currentPath = false) {
	const availableManagers = await pm.getAvailableManagers();
	let manager = await pm.getManager();
	const isDefault = opts.name !== undefined;
	let nodeName: string = opts.name ? opts.name : "";
	let nodeType = "";
	let template = "";
	let nodeStyle = opts.style || ""; // "function" or "class"
	let node_runtime = "";
	let selectedManager = "npm";

	if (!isDefault) {
		console.log(
			figlet.textSync("Blok CLI".toUpperCase(), {
				font: "Digital",
				horizontalLayout: "default",
				verticalLayout: "default",
				width: 100,
				whitespaceBreak: true,
			}),
		);
		console.log("");

		const resolveNodeName = async (): Promise<string> => {
			if (nodeName !== "") {
				return nodeName;
			}

			return (await p.text({
				message: "Please provide a name for the node",
				placeholder: "node-name",
				defaultValue: "",
			})) as string;
		};

		const resolveSelectedManager = async (): Promise<string> => {
			if (availableManagers.length === 1) {
				return availableManagers[0];
			}
			return (await p.select({
				message: "Select the package manager",
				options: availableManagers.map((manager) => ({
					label: manager,
					value: manager,
				})),
			})) as string;
		};

		p.intro(color.inverse(" Creating a new Node "));
		const nanoctlNode = await p.group(
			{
				nodeName: () => resolveNodeName(),
				selectedManager: () => resolveSelectedManager(),
				nodeRuntime: () =>
					p.select({
						message: "Select the nanoservice runtime",
						options: [
							{ label: "TypeScript/Node.js", value: "typescript", hint: "recommended" },
							{ label: "Python 3", value: "python3", hint: "Production - gRPC" },
							{ label: "Go", value: "go", hint: "Production - Docker" },
							{ label: "Java", value: "java", hint: "Production - Docker" },
							{ label: "Rust", value: "rust", hint: "Production - Docker" },
							{ label: "C# / .NET", value: "csharp", hint: "Production - Docker" },
							{ label: "PHP", value: "php", hint: "Production - Docker" },
							{ label: "Ruby", value: "ruby", hint: "Production - Docker" },
						],
					}),
			},
			{
				onCancel: () => {
					p.cancel("Operation canceled.");
					process.exit(0);
				},
			},
		);

		nodeName = nanoctlNode.nodeName;
		node_runtime = nanoctlNode.nodeRuntime;
		selectedManager = nanoctlNode.selectedManager;

		if (node_runtime === "python3") {
			// Show a warning message
			console.log(
				color.yellow(
					"⚠️  Python3 runtime is currently in Alpha and is limited to MacOS and Linux. Please use Typescript for production.",
				),
			);
		}

		// (All runtimes now supported)

		if (node_runtime === "typescript") {
			const nanoctlNodeExtension = await p.group(
				{
					nodeType: () =>
						p.select({
							message: "Select the nanoservice type",
							options: [
								{ label: "Module", value: "module", hint: "recommended" },
								{ label: "Class", value: "class" },
							],
						}),
					nodeStyle: () =>
						p.select({
							message: "Select the node style",
							options: [
								{ label: "Function-First (defineNode)", value: "function", hint: "recommended" },
								{ label: "Class-Based (extends NanoService)", value: "class" },
							],
						}),
					template: () =>
						p.select({
							message: "Select the template",
							options: [
								{ label: "Standard", value: "class", hint: "recommended" },
								{ label: "UI - EJS + ReactJS + TailwindCSS", value: "ui" },
							],
						}),
				},
				{
					onCancel: () => {
						p.cancel("Operation canceled.");
						process.exit(0);
					},
				},
			);

			nodeType = nanoctlNodeExtension.nodeType;
			nodeStyle = nanoctlNodeExtension.nodeStyle;
			template = nanoctlNodeExtension.template;
		}
	}

	const s = p.spinner();
	if (!isDefault) s.start(`Creating the ${node_runtime} node...`);

	try {
		// Prepare the project
		const mainDirExists = fsExtra.existsSync(GITHUB_REPO_LOCAL);
		if (!mainDirExists)
			throw new Error(
				"The blok repository was not found. Please run 'npx nanoctl@latest create project' to clone the repository.",
			);

		if (node_runtime === "typescript") {
			let dirPath = process.cwd();
			if (!currentPath) {
				// Validate the project
				const currentDir = `${process.cwd()}/src`;
				const nodeProjectDirExists = fsExtra.existsSync(currentDir);
				if (!nodeProjectDirExists) throw new Error("ops1");

				// Prepare the node
				const currentNodesDir = `${currentDir}/nodes`;
				if (!isDefault) {
					fsExtra.ensureDirSync(currentNodesDir);
				} else {
					const nodeDirExists = fsExtra.existsSync(currentNodesDir);
					if (!nodeDirExists) throw new Error("ops1");
				}

				dirPath = path.join(currentNodesDir, nodeName);
			}

			if (!isDefault) s.message("Copying project files...");

			/// Copy the node files
			if (!currentPath) {
				const nodeDirExists = fsExtra.existsSync(dirPath);
				if (nodeDirExists) throw new Error("ops2");
			}

			if (nodeType === "module") {
				// Copy template based on node style
				if (nodeStyle === "function") {
					// Use function-first template
					fsExtra.copySync(`${GITHUB_REPO_LOCAL}/templates/node-function`, dirPath);
				} else {
					// Use class-based template
					if (template === "class") {
						fsExtra.copySync(`${GITHUB_REPO_LOCAL}/templates/node`, dirPath);
					}

					if (template === "ui") {
						fsExtra.copySync(`${GITHUB_REPO_LOCAL}/templates/node-ui`, dirPath);
					}
				}

				// Change project name in package.json
				const packageJson = `${dirPath}/package.json`;
				const packageJsonContent = JSON.parse(fsExtra.readFileSync(packageJson, "utf8"));
				packageJsonContent.name = nodeName;
				packageJsonContent.version = "1.0.0";
				packageJsonContent.author = "";
				fsExtra.writeFileSync(packageJson, JSON.stringify(packageJsonContent, null, 2));

				// Update index.ts node name for function-first nodes
				if (nodeStyle === "function") {
					const indexPath = `${dirPath}/index.ts`;
					let indexContent = fsExtra.readFileSync(indexPath, "utf8");
					indexContent = indexContent.replace(/node-name/g, nodeName);
					fsExtra.writeFileSync(indexPath, indexContent);
				}

				// Get the package manager
				manager = await pm.getManager(selectedManager as string);

				// Install Packages
				s.message("Installing packages...");
				await exec(manager.INSTALL, { cwd: dirPath });

				// Build the project
				s.message("Building the project...");
				await exec(manager.BUILD, { cwd: dirPath });
			}

			if (nodeType === "class") {
				fsExtra.ensureDirSync(dirPath);

				if (nodeStyle === "function") {
					// Use function-first inline template for class-type nodes
					const functionNodeContent = function_first_node_file.replace(/\{\{NODE_NAME\}\}/g, nodeName);
					fsExtra.writeFileSync(`${dirPath}/index.ts`, functionNodeContent);
				} else {
					// Use class-based template
					if (template === "class") {
						fsExtra.copyFileSync(`${GITHUB_REPO_LOCAL}/templates/node/index.ts`, `${dirPath}/index.ts`);
					}

					if (template === "ui") {
						fsExtra.ensureDirSync(`${dirPath}/app`);
						fsExtra.copySync(`${GITHUB_REPO_LOCAL}/templates/node-ui/app`, `${dirPath}/app`);
						fsExtra.copyFileSync(`${GITHUB_REPO_LOCAL}/templates/node-ui/index.ts`, `${dirPath}/index.ts`);
						fsExtra.copyFileSync(`${GITHUB_REPO_LOCAL}/templates/node-ui/inputSchema.ts`, `${dirPath}/inputSchema.ts`);
						fsExtra.copyFileSync(`${GITHUB_REPO_LOCAL}/templates/node-ui/index.html`, `${dirPath}/index.html`);
					}
				}
			}
		}

		if (node_runtime === "python3") {
			let dirPath = process.cwd();
			if (!currentPath) {
				// Validate the project
				const currentDir = `${process.cwd()}/runtimes/python3`;
				const nodeProjectDirExists = fsExtra.existsSync(currentDir);
				if (!nodeProjectDirExists) throw new Error("ops3");

				// Prepare the node
				const currentNodesDir = `${currentDir}/nodes`;
				if (!isDefault) {
					fsExtra.ensureDirSync(currentNodesDir);
				} else {
					const nodeDirExists = fsExtra.existsSync(currentNodesDir);
					if (!nodeDirExists) throw new Error("ops3");
				}

				dirPath = path.join(currentNodesDir, nodeName);
			}

			if (!isDefault) s.message("Copying project files...");

			// Copy the node files
			if (!currentPath) {
				const nodeDirExists = fsExtra.existsSync(dirPath);
				if (nodeDirExists) throw new Error("ops2");
			}

			fsExtra.ensureDirSync(dirPath);
			fsExtra.writeFileSync(`${dirPath}/node.py`, python3_file);
			fsExtra.writeFileSync(`${dirPath}/__init__.py`, "");
		}

		if (node_runtime === "go") {
			let dirPath = process.cwd();
			if (!currentPath) {
				// Validate the project
				const currentDir = `${process.cwd()}/runtimes/go`;
				const nodeProjectDirExists = fsExtra.existsSync(currentDir);
				if (!nodeProjectDirExists) {
					// Create runtimes/go directory if it doesn't exist
					fsExtra.ensureDirSync(currentDir);
				}

				// Prepare the node
				const currentNodesDir = `${currentDir}/nodes`;
				if (!isDefault) {
					fsExtra.ensureDirSync(currentNodesDir);
				} else {
					const nodeDirExists = fsExtra.existsSync(currentNodesDir);
					if (!nodeDirExists) {
						fsExtra.ensureDirSync(currentNodesDir);
					}
				}

				dirPath = path.join(currentNodesDir, nodeName);
			}

			if (!isDefault) s.message("Creating Go node files...");

			// Copy the node files
			if (!currentPath) {
				const nodeDirExists = fsExtra.existsSync(dirPath);
				if (nodeDirExists) throw new Error("ops2");
			}

			fsExtra.ensureDirSync(dirPath);

			// Write Go files with node name replacement
			const goNodeContent = go_node_file.replace(/\{\{NODE_NAME\}\}/g, nodeName);
			const goModContent = go_mod_file.replace(/\{\{NODE_NAME\}\}/g, nodeName);
			const goDockerContent = go_dockerfile.replace(/\{\{NODE_NAME\}\}/g, nodeName);

			fsExtra.writeFileSync(`${dirPath}/main.go`, goNodeContent);
			fsExtra.writeFileSync(`${dirPath}/go.mod`, goModContent);
			fsExtra.writeFileSync(`${dirPath}/go.sum`, "");
			fsExtra.writeFileSync(`${dirPath}/Dockerfile`, goDockerContent);

			// Create README
			const readmeContent = `# ${nodeName}\n\nGo-based Blok node.\n\n## Build\n\n\`\`\`bash\ndocker build -t blok-${nodeName}:latest .\n\`\`\`\n\n## Run\n\n\`\`\`bash\ndocker run -p 8080:8080 blok-${nodeName}:latest\n\`\`\`\n`;
			fsExtra.writeFileSync(`${dirPath}/README.md`, readmeContent);
		}

		if (node_runtime === "java") {
			let dirPath = process.cwd();
			if (!currentPath) {
				// Validate the project
				const currentDir = `${process.cwd()}/runtimes/java`;
				const nodeProjectDirExists = fsExtra.existsSync(currentDir);
				if (!nodeProjectDirExists) {
					// Create runtimes/java directory if it doesn't exist
					fsExtra.ensureDirSync(currentDir);
				}

				// Prepare the node
				const currentNodesDir = `${currentDir}/nodes`;
				if (!isDefault) {
					fsExtra.ensureDirSync(currentNodesDir);
				} else {
					const nodeDirExists = fsExtra.existsSync(currentNodesDir);
					if (!nodeDirExists) {
						fsExtra.ensureDirSync(currentNodesDir);
					}
				}

				dirPath = path.join(currentNodesDir, nodeName);
			}

			if (!isDefault) s.message("Creating Java node files...");

			// Copy the node files
			if (!currentPath) {
				const nodeDirExists = fsExtra.existsSync(dirPath);
				if (nodeDirExists) throw new Error("ops2");
			}

			fsExtra.ensureDirSync(dirPath);

			// Create Maven directory structure
			const srcDir = `${dirPath}/src/main/java/com/blok/nodes`;
			fsExtra.ensureDirSync(srcDir);

			// Write Java files with node name replacement
			const javaNodeContent = java_node_file.replace(/\{\{NODE_NAME\}\}/g, nodeName);
			const javaPomContent = java_pom_file.replace(/\{\{NODE_NAME\}\}/g, nodeName);
			const javaDockerContent = java_dockerfile.replace(/\{\{NODE_NAME\}\}/g, nodeName);

			fsExtra.writeFileSync(`${srcDir}/HelloWorldNode.java`, javaNodeContent);
			fsExtra.writeFileSync(`${dirPath}/pom.xml`, javaPomContent);
			fsExtra.writeFileSync(`${dirPath}/Dockerfile`, javaDockerContent);

			// Create README
			const readmeContent = `# ${nodeName}\n\nJava-based Blok node.\n\n## Build\n\n\`\`\`bash\ndocker build -t blok-${nodeName}:latest .\n\`\`\`\n\n## Run\n\n\`\`\`bash\ndocker run -p 8080:8080 blok-${nodeName}:latest\n\`\`\`\n`;
			fsExtra.writeFileSync(`${dirPath}/README.md`, readmeContent);
		}

		if (node_runtime === "rust") {
			let dirPath = process.cwd();
			if (!currentPath) {
				// Validate the project
				const currentDir = `${process.cwd()}/runtimes/rust`;
				const nodeProjectDirExists = fsExtra.existsSync(currentDir);
				if (!nodeProjectDirExists) {
					// Create runtimes/rust directory if it doesn't exist
					fsExtra.ensureDirSync(currentDir);
				}

				// Prepare the node
				const currentNodesDir = `${currentDir}/nodes`;
				if (!isDefault) {
					fsExtra.ensureDirSync(currentNodesDir);
				} else {
					const nodeDirExists = fsExtra.existsSync(currentNodesDir);
					if (!nodeDirExists) {
						fsExtra.ensureDirSync(currentNodesDir);
					}
				}

				dirPath = path.join(currentNodesDir, nodeName);
			}

			if (!isDefault) s.message("Creating Rust node files...");

			// Copy the node files
			if (!currentPath) {
				const nodeDirExists = fsExtra.existsSync(dirPath);
				if (nodeDirExists) throw new Error("ops2");
			}

			fsExtra.ensureDirSync(dirPath);

			// Create src directory
			const srcDir = `${dirPath}/src`;
			fsExtra.ensureDirSync(srcDir);

			// Write Rust files with node name replacement
			const pascalName = toPascalCase(nodeName);
			const rustNodeContent = rust_node_file
				.replace(/\{\{NODE_NAME\}\}/g, nodeName)
				.replace(/\{\{NODE_NAME_PASCAL\}\}/g, pascalName);
			const rustCargoContent = rust_cargo_file.replace(/\{\{NODE_NAME\}\}/g, nodeName);
			const rustDockerContent = rust_dockerfile.replace(/\{\{NODE_NAME\}\}/g, nodeName);

			fsExtra.writeFileSync(`${srcDir}/main.rs`, rustNodeContent);
			fsExtra.writeFileSync(`${dirPath}/Cargo.toml`, rustCargoContent);
			fsExtra.writeFileSync(`${dirPath}/Dockerfile`, rustDockerContent);

			// Create README
			const readmeContent = `# ${nodeName}\n\nRust-based Blok node.\n\n## Build\n\n\`\`\`bash\ndocker build -t blok-${nodeName}:latest .\n\`\`\`\n\n## Run\n\n\`\`\`bash\ndocker run -p 8080:8080 blok-${nodeName}:latest\n\`\`\`\n`;
			fsExtra.writeFileSync(`${dirPath}/README.md`, readmeContent);
		}

		if (node_runtime === "csharp") {
			let dirPath = process.cwd();
			if (!currentPath) {
				const currentDir = `${process.cwd()}/runtimes/csharp`;
				if (!fsExtra.existsSync(currentDir)) {
					fsExtra.ensureDirSync(currentDir);
				}
				const currentNodesDir = `${currentDir}/nodes`;
				fsExtra.ensureDirSync(currentNodesDir);
				dirPath = path.join(currentNodesDir, nodeName);
			}

			if (!isDefault) s.message("Creating C# node files...");

			if (!currentPath) {
				if (fsExtra.existsSync(dirPath)) throw new Error("ops2");
			}

			fsExtra.ensureDirSync(dirPath);
			const srcDir = `${dirPath}/src/Nodes`;
			fsExtra.ensureDirSync(srcDir);

			const pascalName = toPascalCase(nodeName);
			const csNodeContent = csharp_node_file.replace(/\{\{NODE_NAME_PASCAL\}\}/g, pascalName);
			const csprojContent = csharp_csproj_file.replace(/\{\{NODE_NAME\}\}/g, nodeName);
			const csDockerContent = csharp_dockerfile.replace(/\{\{NODE_NAME\}\}/g, nodeName);

			fsExtra.writeFileSync(`${srcDir}/${pascalName}Node.cs`, csNodeContent);
			fsExtra.writeFileSync(`${dirPath}/BlokRuntime.csproj`, csprojContent);
			fsExtra.writeFileSync(`${dirPath}/Dockerfile`, csDockerContent);

			const readmeContent = `# ${nodeName}\n\nC#/.NET-based Blok node.\n\n## Build\n\n\`\`\`bash\ndocker build -t blok-${nodeName}:latest .\n\`\`\`\n\n## Run\n\n\`\`\`bash\ndocker run -p 8080:8080 blok-${nodeName}:latest\n\`\`\`\n`;
			fsExtra.writeFileSync(`${dirPath}/README.md`, readmeContent);
		}

		if (node_runtime === "php") {
			let dirPath = process.cwd();
			if (!currentPath) {
				const currentDir = `${process.cwd()}/runtimes/php`;
				if (!fsExtra.existsSync(currentDir)) {
					fsExtra.ensureDirSync(currentDir);
				}
				const currentNodesDir = `${currentDir}/nodes`;
				fsExtra.ensureDirSync(currentNodesDir);
				dirPath = path.join(currentNodesDir, nodeName);
			}

			if (!isDefault) s.message("Creating PHP node files...");

			if (!currentPath) {
				if (fsExtra.existsSync(dirPath)) throw new Error("ops2");
			}

			fsExtra.ensureDirSync(dirPath);
			const srcDir = `${dirPath}/src/Nodes`;
			fsExtra.ensureDirSync(srcDir);

			const pascalName = toPascalCase(nodeName);
			const phpNodeContent = php_node_file
				.replace(/\{\{NODE_NAME\}\}/g, nodeName)
				.replace(/\{\{NODE_NAME_PASCAL\}\}/g, pascalName);
			const phpComposerContent = php_composer_file.replace(/\{\{NODE_NAME\}\}/g, nodeName);
			const phpDockerContent = php_dockerfile.replace(/\{\{NODE_NAME\}\}/g, nodeName);

			fsExtra.writeFileSync(`${srcDir}/${pascalName}Node.php`, phpNodeContent);
			fsExtra.writeFileSync(`${dirPath}/composer.json`, phpComposerContent);
			fsExtra.writeFileSync(`${dirPath}/Dockerfile`, phpDockerContent);

			const readmeContent = `# ${nodeName}\n\nPHP-based Blok node.\n\n## Build\n\n\`\`\`bash\ndocker build -t blok-${nodeName}:latest .\n\`\`\`\n\n## Run\n\n\`\`\`bash\ndocker run -p 8080:8080 blok-${nodeName}:latest\n\`\`\`\n`;
			fsExtra.writeFileSync(`${dirPath}/README.md`, readmeContent);
		}

		if (node_runtime === "ruby") {
			let dirPath = process.cwd();
			if (!currentPath) {
				const currentDir = `${process.cwd()}/runtimes/ruby`;
				if (!fsExtra.existsSync(currentDir)) {
					fsExtra.ensureDirSync(currentDir);
				}
				const currentNodesDir = `${currentDir}/nodes`;
				fsExtra.ensureDirSync(currentNodesDir);
				dirPath = path.join(currentNodesDir, nodeName);
			}

			if (!isDefault) s.message("Creating Ruby node files...");

			if (!currentPath) {
				if (fsExtra.existsSync(dirPath)) throw new Error("ops2");
			}

			fsExtra.ensureDirSync(dirPath);
			const libDir = `${dirPath}/lib/nodes`;
			fsExtra.ensureDirSync(libDir);

			const pascalName = toPascalCase(nodeName);
			const rubyNodeContent = ruby_node_file
				.replace(/\{\{NODE_NAME\}\}/g, nodeName)
				.replace(/\{\{NODE_NAME_PASCAL\}\}/g, pascalName);
			const rubyGemContent = ruby_gemfile.replace(/\{\{NODE_NAME\}\}/g, nodeName);
			const rubyDockerContent = ruby_dockerfile.replace(/\{\{NODE_NAME\}\}/g, nodeName);

			fsExtra.writeFileSync(`${libDir}/${nodeName.replace(/-/g, "_")}.rb`, rubyNodeContent);
			fsExtra.writeFileSync(`${dirPath}/Gemfile`, rubyGemContent);
			fsExtra.writeFileSync(`${dirPath}/Dockerfile`, rubyDockerContent);

			const readmeContent = `# ${nodeName}\n\nRuby-based Blok node.\n\n## Build\n\n\`\`\`bash\ndocker build -t blok-${nodeName}:latest .\n\`\`\`\n\n## Run\n\n\`\`\`bash\ndocker run -p 8080:8080 blok-${nodeName}:latest\n\`\`\`\n`;
			fsExtra.writeFileSync(`${dirPath}/README.md`, readmeContent);
		}

		if (!isDefault) s.stop(`Node "${nodeName}" created successfully.`);

		// Show navigation instructions based on runtime
		if (!currentPath && node_runtime === "typescript") {
			console.log(`\nNavigate to the node directory by running: cd src/nodes/${nodeName}`);
			console.log(
				`${currentPath ? "\n" : ""}Run the command "npm run build" or "npm run build:dev" to build the project.`,
			);

			// Show style-specific tips
			if (nodeStyle === "function") {
				console.log(color.cyan("\n✨ Function-First Node Created!"));
				console.log("  • Type-safe with Zod validation");
				console.log("  • 60% less boilerplate than class-based");
				console.log("  • AI-friendly for code generation");
				console.log("\n📖 Learn more: https://blok.build/docs/nodes/function-first");
			}
		}

		if (!currentPath && node_runtime === "python3") {
			console.log(`\nNavigate to the node directory by running: cd runtimes/python3/nodes/${nodeName}`);
		}

		if (!currentPath && node_runtime === "go") {
			console.log(`\nNavigate to the node directory by running: cd runtimes/go/nodes/${nodeName}`);
			console.log(`\nBuild the Docker image: docker build -t blok-${nodeName}:latest .`);
			console.log(`Run the container: docker run -p 8080:8080 blok-${nodeName}:latest`);
		}

		if (!currentPath && node_runtime === "java") {
			console.log(`\nNavigate to the node directory by running: cd runtimes/java/nodes/${nodeName}`);
			console.log(`\nBuild the Docker image: docker build -t blok-${nodeName}:latest .`);
			console.log(`Run the container: docker run -p 8080:8080 blok-${nodeName}:latest`);
		}

		if (!currentPath && node_runtime === "rust") {
			console.log(`\nNavigate to the node directory by running: cd runtimes/rust/nodes/${nodeName}`);
			console.log(`\nBuild the Docker image: docker build -t blok-${nodeName}:latest .`);
			console.log(`Run the container: docker run -p 8080:8080 blok-${nodeName}:latest`);
		}

		if (!currentPath && node_runtime === "csharp") {
			console.log(`\nNavigate to the node directory by running: cd runtimes/csharp/nodes/${nodeName}`);
			console.log(`\nBuild the Docker image: docker build -t blok-${nodeName}:latest .`);
			console.log(`Run the container: docker run -p 8080:8080 blok-${nodeName}:latest`);
		}

		if (!currentPath && node_runtime === "php") {
			console.log(`\nNavigate to the node directory by running: cd runtimes/php/nodes/${nodeName}`);
			console.log(`\nBuild the Docker image: docker build -t blok-${nodeName}:latest .`);
			console.log(`Run the container: docker run -p 8080:8080 blok-${nodeName}:latest`);
		}

		if (!currentPath && node_runtime === "ruby") {
			console.log(`\nNavigate to the node directory by running: cd runtimes/ruby/nodes/${nodeName}`);
			console.log(`\nBuild the Docker image: docker build -t blok-${nodeName}:latest .`);
			console.log(`Run the container: docker run -p 8080:8080 blok-${nodeName}:latest`);
		}

		console.log("\nFor more documentation, visit https://blok.build/docs/d/core-concepts/nodes");
	} catch (error) {
		if (!isDefault) s.stop("An error occurred");

		const message = (error as Error).message;
		if (message === "ops1") {
			console.log(
				"Oops! It seems like you haven't created a project yet... or have you? 🤔\n" +
					"If you already did, you can navigate to it using: cd project-name\n" +
					"Otherwise, you can create a new project with: npx nanoctl@latest create project",
			);
		}
		if (message === "ops2") {
			console.log(
				"The node you are trying to create already exists in the project.\n" +
					"Please use a different name, or delete the existing node to create a new one.",
			);
		}
		if (message === "ops3") {
			console.log(
				"Oops! It seems like you haven't created a project with python3 support yet... or have you? 🤔\n" +
					"If you already did, you can navigate to it using: cd project-name\n" +
					"Otherwise, you can create a new project with: npx nanoctl@latest create project",
			);
		}
		if (message !== "ops1" && message !== "ops2") {
			console.log((error as Error).message);
		}
	}
}
