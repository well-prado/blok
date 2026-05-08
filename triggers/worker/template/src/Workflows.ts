import type Workflows from "./runner/types/Workflows";
import processJob from "./workflows/jobs/process-job";

const workflows: Workflows = {
	"process-job": processJob,
};

export default workflows;
