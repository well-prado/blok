import type { ParamsDictionary } from "@blokjs/runner";
import type { NodeBase, Step } from "@blokjs/shared";

export function validateRoute(dynamicRoute: string, actualRoute: string) {
	if (!dynamicRoute || !actualRoute) return false;
	// Convert dynamicRoute to a regex pattern
	const regexPattern = dynamicRoute
		.replace(/\/:\w+\?/g, "(?:/([^/]+)?)?") // Optional parameter handling
		.replace(/\/:\w+/g, "/([^/]+)")
		.replace(/\*/g, ".*");

	// Create a new RegExp to match the dynamic route pattern
	const dynamicRouteRegExp = new RegExp(`^${regexPattern}$`);
	// Test the actual route against the dynamic route pattern
	return dynamicRouteRegExp.test(actualRoute);
}

export function handleDynamicRoute(
	dynamicRoute: string,
	requestPath: string,
	existingParams: Record<string, string>,
): ParamsDictionary {
	const params: ParamsDictionary = { ...existingParams };

	// Extract the parameter names from the dynamic route pattern
	const paramNames = dynamicRoute.match(/:(\w+)/g)?.map((name: string) => name.substring(1));
	if (paramNames) {
		// Create a new RegExp to match the dynamic route pattern
		const dynamicRouteRegExp = new RegExp(`^${dynamicRoute.replace(/:\w+/g, "([^\\/]+)")}$`);
		// Test the actual route against the dynamic route pattern
		const match = requestPath.match(dynamicRouteRegExp);
		if (match) {
			// Extract the parameter values from the actual route
			const matchedParams = match.slice(1);
			paramNames.forEach((name: string | number, index: number) => {
				params[name] = matchedParams[index];
			});
		} else {
			const pathParts = requestPath.split("/");
			const dynamicRouteSplitted = dynamicRoute.split("/");
			dynamicRouteSplitted.forEach((name: string, i: number) => {
				if (name.startsWith(":")) params[name.replace(":", "").replace("?", "")] = pathParts[i];
			});
		}
	}

	return params;
}

export async function nodeResolver(node: Step): Promise<NodeBase> {
	return new (await import(node.node)).default() as Promise<NodeBase>;
}
