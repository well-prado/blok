import type ErrorContext from "./types/ErrorContext";
import type ParamsDictionary from "./types/ParamsDictionary";

export default class GlobalError extends Error {
	public context: ErrorContext = { message: "" };

	constructor(msg: string | undefined) {
		super(msg);
		// Standard Error-subclass pattern: pin to new.target's prototype (the
		// class actually being constructed), not GlobalError's own — otherwise
		// this clobbers a subclass's correct prototype and `instanceof Subclass`
		// silently fails for any subclass that doesn't re-pin itself (#736).
		Object.setPrototypeOf(this, new.target.prototype);

		this.context.message = msg as string;
	}

	setCode(code?: number) {
		this.context.code = code;
	}
	setJson(json?: Record<string, unknown>) {
		this.context.json = json as ParamsDictionary;
	}
	setStack(stack?: string) {
		this.context.stack = stack;
	}
	setName(name?: string) {
		this.context.name = name;
	}

	hasJson(): boolean {
		return this.context.json !== undefined;
	}

	override toString(): string {
		if (this.context.json) return JSON.stringify(this.context.json);
		return this.context.message as string;
	}
}
