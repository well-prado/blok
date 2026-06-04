import type { GlobalError, NodeBase, ResponseContext } from "@blokjs/shared";
import type JsonLikeObject from "./types/JsonLikeObject";

export interface IBlokResponse extends ResponseContext {
	steps: NodeBase[];
}

/**
 * Body shapes a node may return. Beyond JSON, the `http` trigger can emit raw
 * binary (`Uint8Array`/`Buffer`/`ArrayBuffer`) and a branded response envelope
 * (object) — so the union is widened to keep those returns type-safe.
 */
export type BlokResponseData = string | JsonLikeObject | JsonLikeObject[] | Uint8Array | ArrayBuffer;

export default class BlokResponse implements IBlokResponse {
	public steps: NodeBase[];
	public data: BlokResponseData;
	public error: GlobalError | null;
	public success?: boolean | undefined;
	public contentType?: string | undefined;

	constructor() {
		this.steps = [];
		this.data = {};
		this.error = null;
		this.success = true;
		this.contentType = "application/json";
	}

	setError(error: GlobalError): void {
		this.error = error;
		this.success = false;
		this.data = {};
	}

	setSuccess(data: BlokResponseData): void {
		this.data = data;
		this.error = null;
		this.success = true;
	}

	setSteps(steps: NodeBase[]): void {
		this.steps = steps;
	}
}
