import ChatUI from "./chat-ui";

// The example-node bundle registered into --examples scaffolds (via the
// generated src/Nodes.ts) and auto-discovered by the trigger's own boot.
// Keep this in lock-step with the shipped example workflows: a node with no
// workflow referencing it is dead weight in every project (the 2026-07 purge
// removed 17 such orphans — db-manager, dashboard-generator, workflow-docs,
// mastra-agent, etc. — see git history to resurrect any of them WITH a
// registered workflow).
const ExampleNodes = {
	"chat-ui": ChatUI,
};

export default ExampleNodes;
