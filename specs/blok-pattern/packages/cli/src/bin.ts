// The entry of the single-file build of blokctl, which needs no Node and no node_modules:
//
//     bun build --compile packages/cli/src/bin.ts --outfile blokctl
//
// It is how a project in another language gets the tool. The files blokctl ships with are carried inside it.
import workflowPkl from "../assets/Workflow.pkl" with { type: "text" };
import workflowSchema from "../assets/workflow.schema.json" with { type: "text" };
import manifest from "../package.json" with { type: "json" };
import { setStandalone } from "./standalone.ts";

setStandalone({ "Workflow.pkl": workflowPkl, "workflow.schema.json": workflowSchema }, manifest.version);
// After the line above, so that everything the command line loads already finds its files.
await import("./cli.ts");
