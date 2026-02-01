/**
 * Hono sub-app used to define custom application routes.
 *
 * @remarks
 * This app is currently minimal. You can create routes by using methods like `app.get`, `app.post`, etc.
 * Example:
 * ```typescript
 * app.get('/example', (c) => {
 *   return c.text('Example route');
 * });
 * ```
 *
 * @module AppRoutes
 */

import { Hono } from "hono";
const app = new Hono();

app.get("/", (c) => {
	const html = `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>Welcome to blok SSE</title>
		<link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
		<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
		<style>
			body { font-family: 'Inter', sans-serif; }
		</style>
	</head>
	<body class="bg-gray-50 text-gray-800 min-h-screen flex flex-col">
		<main class="grow flex items-center justify-center px-4">
			<div class="max-w-3xl bg-white shadow-xl rounded-2xl p-10 border border-gray-200">
				<h1 class="text-3xl font-semibold mb-6 text-center text-blue-700">Welcome to <span class="text-black">blok</span> SSE</h1>
				<p class="text-lg mb-4">Your SSE (Server-Sent Events) trigger is running. Here's how to use it:</p>
				<ol class="list-decimal list-inside mb-6 space-y-2 text-base text-gray-700">
					<li><strong>Connect</strong> to an SSE stream: <code class="bg-gray-100 px-2 py-1 rounded">curl -N http://localhost:4001/events/my-channel</code></li>
					<li><strong>Publish</strong> events to a channel: <code class="bg-gray-100 px-2 py-1 rounded">curl -X POST http://localhost:4001/events/my-channel/publish -H "Content-Type: application/json" -d '{"event":"hello","data":{"msg":"world"}}'</code></li>
					<li><strong>View</strong> connection stats: <code class="bg-gray-100 px-2 py-1 rounded">curl http://localhost:4001/clients</code></li>
					<li><strong>List</strong> active channels: <code class="bg-gray-100 px-2 py-1 rounded">curl http://localhost:4001/channels</code></li>
					<li><strong>Monitor</strong> with Blok Studio: <code class="bg-gray-100 px-2 py-1 rounded">npx blokctl@latest trace</code></li>
				</ol>

				<div class="mt-8 text-center">
					<a href="https://blok.build/" target="_blank" class="inline-block bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 transition">Explore Docs</a>
				</div>
			</div>
		</main>

		<footer class="text-center text-sm text-gray-500 py-4">
			<p>Made with care by the <a href="https://deskree.com/" target="_blank" class="text-blue-600 hover:underline">Deskree</a> team.</p>
		</footer>
	</body>
	</html>
	`;

	return c.html(html, 200);
});

export default app;
