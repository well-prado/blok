import LocalStorage from "./LocalStorage";
import type GlobalOptions from "./types/GlobalOptions";
import type Targets from "./types/Targets";
import { normalizeWorkflow } from "./workflow/WorkflowNormalizer";

/**
 * ConfigurationResolver loads a workflow from any registered storage target
 * (filesystem, in-memory, etc.) and runs it through the v1→v2 normalizer
 * before returning it to the caller.
 *
 * This is the single pinch point for workflow loading — every trigger
 * (HTTP, Cron, future) goes through here, so the normalizer applies once
 * regardless of how the workflow is fetched.
 */
export default class ConfigurationResolver {
	private targets: Targets = {};
	private globalOptions: GlobalOptions = <GlobalOptions>{};

	constructor(opts: GlobalOptions) {
		this.targets = {
			local: new LocalStorage(),
		};

		this.globalOptions = opts;
	}

	async get(target: string, name: string) {
		const raw = await this.targets[target].get(name, this.globalOptions.workflows);
		// Normalize v1 → v2 (or pass v2 through). Always returns the
		// canonical internal shape that Configuration.getSteps consumes.
		// Cast back to `unknown` so the existing call-site (`Configuration.init`)
		// continues to use its own untyped projections — no type churn beyond
		// this one point.
		return normalizeWorkflow(raw, name) as unknown as Awaited<ReturnType<(typeof this.targets)["local"]["get"]>>;
	}
}
