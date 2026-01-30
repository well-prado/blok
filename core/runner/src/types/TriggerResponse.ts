import type { Context, MetricsType } from "@blok/shared";

type TriggerResponse = {
	ctx: Context;
	metrics: MetricsType;
};

export default TriggerResponse;
