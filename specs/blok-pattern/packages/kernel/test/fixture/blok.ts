import { blok } from "../../src/index.ts";

export interface Ports {
	seen: number[];
}
export const { node, runtime } = blok<Ports>();
