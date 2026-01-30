import type { NodeBase } from "@blok/shared";

type Condition = {
	type?: string;
	condition: string;
	steps?: NodeBase[];
	error?: string;
};

export default Condition;
