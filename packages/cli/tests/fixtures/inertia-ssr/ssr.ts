import { writeFileSync } from "node:fs";
import { createInertiaApp } from "@inertiajs/react";
import createServer from "@inertiajs/react/server";
import { createElement } from "react";
import ReactDOMServer from "react-dom/server";
import Home from "./Home";

if (process.env.SSR_ARGV_FILE) {
	writeFileSync(process.env.SSR_ARGV_FILE, JSON.stringify({ execPath: process.execPath, argv: process.argv }));
}

createServer(
	(page) =>
		createInertiaApp({
			page,
			render: ReactDOMServer.renderToString,
			resolve: (name) => {
				if (name !== "Home") throw new Error(`Unknown fixture page: ${name}`);
				return Home;
			},
			setup: ({ App, props }) => createElement(App, props),
		}),
	{
		port: Number(process.env.BLOK_SSR_PORT ?? 13714),
		host: process.env.BLOK_SSR_HOST ?? "127.0.0.1",
		cluster: process.env.BLOK_SSR_CLUSTER === "true",
	},
);
