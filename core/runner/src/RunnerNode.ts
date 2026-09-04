import { type Context, NodeBase, type ResponseContext, type Step } from "@blokjs/shared";
import type { WasiComponentManifestV1 } from "@blokjs/shared";
import type { RuntimeKind } from "./adapters/RuntimeAdapter";

export default abstract class RunnerNode extends NodeBase implements Step {
	public node = "";
	public type = "";
	public runtime?: RuntimeKind;
	public config?: Record<string, unknown>;
	/** Validated runtime.wasi component identity and capability declaration. */
	public wasiComponent?: WasiComponentManifestV1;

	abstract run(ctx: Context): Promise<ResponseContext>;
}
