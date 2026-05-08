import type { NodeBase } from "@blokjs/shared";

type Condition = {
	type?: string;
	condition: string;
	steps?: NodeBase[];
	error?: string;
};

export default Condition;
