import type Workflows from "./runner/types/Workflows";
import onMessage from "./workflows/messages/on-message";

const workflows: Workflows = {
	"on-message": onMessage,
};

export default workflows;
