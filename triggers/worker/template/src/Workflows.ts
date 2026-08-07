import type Workflows from "./runner/types/Workflows.js";
import processJob from "./workflows/jobs/process-job.js";

const workflows: Workflows = {
	"process-job": processJob,
};

export default workflows;
