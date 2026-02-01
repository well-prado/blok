import type Workflows from "./runner/types/Workflows";
import onConnect from "./workflows/notifications/on-connect";
import onSubscribe from "./workflows/notifications/on-subscribe";

const workflows: Workflows = {
	"on-connect": onConnect,
	"on-subscribe": onSubscribe,
};

export default workflows;
