import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { ChartWindow } from "./chart.ts";
import type { ChartPayload } from "./data.ts";
import { renderHtml } from "./ui.ts";

function launchBrowser(url: string): Promise<void> {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
	const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 10_000 }, (error) => error ? reject(error) : resolve());
	});
}

export async function openBrowserChart(
	initialPayload: ChartPayload,
	onClosed: () => void,
	openBrowser: (url: string) => Promise<void> = launchBrowser,
): Promise<ChartWindow> {
	let payload = initialPayload;
	let payloadJson = JSON.stringify(payload);
	let closed = false;
	let host = "";
	const base = `/${randomBytes(24).toString("hex")}/`;
	const server = createServer((req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Frame-Options", "DENY");
		if (req.headers.host !== host || req.method !== "GET") {
			res.writeHead(403).end();
			return;
		}
		if (req.url === base) {
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(renderHtml(payload, "payload"));
		} else if (req.url === `${base}payload`) {
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(payloadJson);
		} else {
			res.writeHead(404).end();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Could not start context chart server");
	}
	host = `127.0.0.1:${address.port}`;
	const url = `http://${host}${base}`;
	server.unref();
	const close = () => {
		if (closed) return;
		closed = true;
		server.close();
		server.closeAllConnections();
		onClosed();
	};
	try {
		await openBrowser(url);
	} catch (error) {
		close();
		throw new Error(`Could not launch browser: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		url,
		publish(next) {
			payloadJson = JSON.stringify(next);
			payload = next;
		},
		close,
	};
}
