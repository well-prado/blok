import type { WorkflowV2Builder } from "@blokjs/helper";

// HTTP JSON + TS workflows are auto-discovered from workflows/json/ and workflows/**/*.ts

const workflows: Record<string, WorkflowV2Builder> = {
	// Add your workflows here
};

export default workflows;
