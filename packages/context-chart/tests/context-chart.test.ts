import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import contextChart from "../src/context-chart.ts";
import { openBrowserChart } from "../src/browser.ts";
import { buildChartPayload, computeSharedState } from "../src/data.ts";
import { renderHtml } from "../src/ui.ts";

function context(): ExtensionContext {
	return {
		getSystemPrompt: () => "system </script><script>alert(1)</script>",
		getContextUsage: () => undefined,
		model: undefined,
		sessionManager: {
			getEntries: () => [], getBranch: () => [], getLeafId: () => null,
			getSessionName: () => undefined, getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;
}

function payload() {
	const ctx = context();
	return buildChartPayload(computeSharedState(ctx), ctx);
}

test("inspector reconstructs context and copies observed messages/tools", () => {
	const ctx = context();
	const current = computeSharedState(ctx);
	assert.equal(current.context.source, "reconstructed");
	assert.deepEqual(current.context.messages, []);
	const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }];
	const tools = [{ name: "read", parameters: { type: "object" } }];
	const observed = computeSharedState(ctx, { type: "context", messages }, tools);
	assert.equal(observed.context.source, "observed");
	assert.deepEqual(observed.context.messages, messages);
	messages[0].content = "changed";
	tools[0].parameters.type = "changed";
	assert.equal(observed.context.messages[0].content, "hello");
	assert.deepEqual(observed.context.tools[0].parameters, { type: "object" });
	assert.equal(buildChartPayload(observed, ctx).context, observed.context);
});

test("HTML safely embeds context and emits valid JS for both transports", () => {
	for (const pollUrl of [undefined, "payload"]) {
		const html = renderHtml(payload(), pollUrl);
		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
		assert.equal(scripts.length, 1);
		assert.ok(!html.includes("system </script>"));
		assert.ok(html.includes("Context inspector"));
		new Script(scripts[0][1]);
	}
});

test("polling recovers after a failure even when the payload has not changed", async () => {
	const html = renderHtml(payload(), "payload");
	const start = html.indexOf('const pollUrl =');
	const end = html.indexOf('// Cmd+/- zoom support', start);
	const timers: Array<() => Promise<void>> = [];
	const status = { textContent: "" };
	let requests = 0;
	let metadataUpdates = 0;
	new Script(html.slice(start, end)).runInNewContext({
		AbortSignal,
		currentPayload: { meta: { updatedAt: 1 } },
		document: { getElementById: () => status },
		window: { updateChart: () => assert.fail("Unchanged payload should not redraw the chart") },
		updateMeta: () => { metadataUpdates++; status.textContent = "Connected"; },
		fetch: async () => {
			if (++requests === 1) throw new Error("offline");
			return { ok: true, json: async () => ({ meta: { updatedAt: 1 } }) };
		},
		setTimeout: (callback: () => Promise<void>) => timers.push(callback),
	});
	await new Promise(resolve => setImmediate(resolve));
	assert.match(status.textContent, /Disconnected/);
	assert.equal(timers.length, 1);
	await timers.shift()!();
	assert.equal(metadataUpdates, 1);
	assert.equal(status.textContent, "Connected");
	assert.equal(timers.length, 1);
});

test("browser serves live payload, protects routes, and closes idempotently", async () => {
	let url = "";
	let closed = 0;
	const initial = payload();
	const win = await openBrowserChart(initial, () => closed++, async (value) => { url = value; });
	try {
		assert.equal(win.url, url);
		assert.equal(new URL(url).hostname, "127.0.0.1");
		assert.match(new URL(url).pathname, /^\/[a-f0-9]{48}\/$/);
		const page = await fetch(url);
		assert.equal(page.headers.get("cache-control"), "no-store");
		assert.equal(page.headers.get("referrer-policy"), "no-referrer");
		assert.ok((await page.text()).includes('const pollUrl = "payload"'));
		assert.deepEqual(await (await fetch(url + "payload")).json(), JSON.parse(JSON.stringify(initial)));
		const next = { ...initial, meta: { ...initial.meta, updatedAt: initial.meta.updatedAt + 1 } };
		win.publish(next);
		assert.deepEqual(await (await fetch(url + "payload")).json(), JSON.parse(JSON.stringify(next)));
		assert.equal((await fetch(new URL("/payload", url))).status, 404);
		assert.equal((await fetch(url, { method: "POST" })).status, 403);
		const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
			request(url, { headers: { Host: "evil.example" } }, (res) => {
				res.resume();
				resolve(res.statusCode);
			}).on("error", reject).end();
		});
		assert.equal(invalidHostStatus, 403);
		assert.equal((await fetch(url + "payload")).headers.get("access-control-allow-origin"), null);
	} finally {
		win.close();
		win.close();
	}
	assert.equal(closed, 1);
	await assert.rejects(fetch(url));
});

test("closing during startup does not leave a chart open", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "context-chart-test-"));
	const glimpsePath = path.join(dir, "glimpse.mjs");
	const previousPath = process.env.GLIMPSE_PATH;
	let command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
	await writeFile(glimpsePath, `
		await new Promise(resolve => setTimeout(resolve, 30));
		export const windows = [];
		export function open() {
			const win = { closed: false, on() {}, send() {}, close() { this.closed = true; } };
			windows.push(win);
			return win;
		}
	`);
	process.env.GLIMPSE_PATH = glimpsePath;
	try {
		contextChart({
			getActiveTools: () => [], getAllTools: () => [], on() {},
			registerCommand: (_name, value) => { command = value; },
		} as unknown as ExtensionAPI);
		const ctx = { ...context(), ui: { notify() {} } } as unknown as ExtensionCommandContext;
		const opening = command!.handler("", ctx);
		const duplicate = command!.handler("", ctx);
		await command!.handler("close", ctx);
		await Promise.all([opening, duplicate]);
		const { windows } = await import(pathToFileURL(glimpsePath).href);
		assert.equal(windows.length, 1);
		assert.equal(windows[0].closed, true);
		await command!.handler("", ctx);
		assert.equal(windows.length, 2);
		assert.equal(windows[1].closed, false);
		await command!.handler("close", ctx);
		assert.equal(windows[1].closed, true);
	} finally {
		if (previousPath === undefined) delete process.env.GLIMPSE_PATH;
		else process.env.GLIMPSE_PATH = previousPath;
		await rm(dir, { recursive: true, force: true });
	}
});

test("failed browser launch cleans up the server", async () => {
	let url = "";
	let closed = 0;
	await assert.rejects(openBrowserChart(payload(), () => closed++, async (value) => {
		url = value;
		throw new Error("no browser");
	}), /Could not launch browser: no browser/);
	assert.equal(closed, 1);
	await assert.rejects(fetch(url));
});
