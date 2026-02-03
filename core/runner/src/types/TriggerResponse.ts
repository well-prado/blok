import type { Context, MetricsType } from "@blokjs/shared";

type TriggerResponse = {
	ctx: Context;
	metrics: MetricsType;
};

export default TriggerResponse;
