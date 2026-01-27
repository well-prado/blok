import { type Context, NodeBase, type ResponseContext, type Step } from "@nanoservice-ts/shared";
import type { RuntimeKind } from "./adapters/RuntimeAdapter";

export default abstract class RunnerNode extends NodeBase implements Step {
	public node = "";
	public type = "";
	public runtime?: RuntimeKind;
	public config?: Record<string, unknown>;

	abstract run(ctx: Context): Promise<ResponseContext>;
}
