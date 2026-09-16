import { createInertiaApp } from "@inertiajs/react";
import createServer from "@inertiajs/react/server";
import type { ComponentType } from "react";
import { renderToString } from "react-dom/server";

// The SSR bundle resolves pages EAGERLY (one process, every page already in the
// bundle) and spells the resolver out, unlike the client entry's `pages`
// shorthand: `createInertiaApp`'s SSR overload requires an explicit `resolve`.
const pages = import.meta.glob<{ default: ComponentType }>("./pages/**/*.tsx", { eager: true });

// Inertia's SSR server (`POST /render` on :13714). `blokctl inertia start-ssr`
// boots the bundle this file produces (`dist-ssr/ssr.js`); the Blok server finds
// the endpoint through `dist/.blok-ssr-url`, written by `blokInertia()`.
createServer(
	(page) =>
		createInertiaApp({
			page,
			render: renderToString,
			resolve: (name) => pages[`./pages/${name}.tsx`],
			setup: ({ App, props }) => <App {...props} />,
		}),
	{
		// #1003 — `createServer`'s port/host/cluster come from its SECOND argument,
		// never from the environment. Without this block
		// `blokctl inertia start-ssr --port/--host/--cluster` set BLOK_SSR_* and
		// the bundle ignored all three, always binding 13714 on 0.0.0.0.
		port: Number(process.env.BLOK_SSR_PORT ?? 13714),
		host: process.env.BLOK_SSR_HOST ?? "127.0.0.1",
		cluster: process.env.BLOK_SSR_CLUSTER === "true",
	},
);
