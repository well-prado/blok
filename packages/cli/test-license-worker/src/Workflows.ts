import type { WorkflowV2Builder } from "@blokjs/helper";

import ProcessJob from "./workflows/worker/jobs/process-job.js";

const workflows: Record<string, WorkflowV2Builder> = {
	"process-job": await ProcessJob,
};

export default workflows;
