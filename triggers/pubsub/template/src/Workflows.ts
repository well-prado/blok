import type Workflows from "./runner/types/Workflows.js";
import onMessage from "./workflows/messages/on-message.js";

const workflows: Workflows = {
	"on-message": onMessage,
};

export default workflows;
