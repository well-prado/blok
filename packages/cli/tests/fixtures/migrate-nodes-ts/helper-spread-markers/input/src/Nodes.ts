import { HELPER_NODES as BUILT_INS } from "@blokjs/helpers";
import CustomNode from "./nodes/custom";
import DupeNode from "./nodes/dupe";

const localNodes = {
	dupe: DupeNode,

	// Reformatted on purpose: the codemod must parse AST, not regex-patch text.
	"custom-node": CustomNode,
};

const nodes = {
	...BUILT_INS,
	...localNodes,
};

export default nodes;
