import { pathToFileURL } from "node:url";
import type { AgentMessage, AssistantMessage, Usage } from "@mariozechner/pi-ai";
import {
    buildSessionContext,
    estimateTokens,
    type ContextEvent,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionEntry,
} from "@mariozechner/pi-coding-agent";

const GLIMPSE_PATH = "/Users/ydai/.npm-global/lib/node_modules/glimpseui/src/glimpse.mjs";
const WINDOW_TITLE = "Session Context Usage";
const EXTENSION_SNAPSHOT_VERSION = 1;

type Snapshot = {
    version: number;
    turn: number;
    systemInstructions: number;
    userInput: number;
    agentOutput: number;
    tools: number;
    memory: number;
    total: number;
    source: "recorded" | "live";
    timestamp?: number;
};

type ChartPayload = {
    points: Snapshot[];
    meta: {
        model: string | null;
        sessionName: string | null;
        sessionFile: string | null;
        contextWindow: number | null;
        currentTotal: number;
        currentPercent: number | null;
        usage: UsageSummary;
        updatedAt: number;
    };
};

type UsageSummary = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
};

type GlimpseWindow = {
    on(event: "ready", handler: () => void): void;
    on(event: "closed", handler: () => void): void;
    send(js: string): void;
    close(): void;
};

export default function (pi: ExtensionAPI) {
    let recordedSnapshots: Snapshot[] = [];
    let liveSnapshot: Snapshot | null = null;
    let windowRef: GlimpseWindow | null = null;
    let windowReady = false;
    let lastPayload: ChartPayload | null = null;

    pi.registerCommand("context-chart", {
        description: "Open a live context usage chart in Glimpse",
        handler: async (args, ctx) => {
            const command = args.trim().toLowerCase();

            if (command === "close") {
                closeWindow();
                ctx.ui.notify("Context chart closed", "info");
                return;
            }

            recordedSnapshots = buildRecordedSnapshots(ctx);
            liveSnapshot = null;
            await openOrRefreshWindow(ctx);
            ctx.ui.notify("Context chart opened", "info");
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        recordedSnapshots = buildRecordedSnapshots(ctx);
        liveSnapshot = null;
        await publish(ctx);
    });

    pi.on("session_switch", async (_event, ctx) => {
        recordedSnapshots = buildRecordedSnapshots(ctx);
        liveSnapshot = null;
        await publish(ctx);
    });

    pi.on("session_fork", async (_event, ctx) => {
        recordedSnapshots = buildRecordedSnapshots(ctx);
        liveSnapshot = null;
        await publish(ctx);
    });

    pi.on("session_compact", async (_event, ctx) => {
        recordedSnapshots = buildRecordedSnapshots(ctx);
        liveSnapshot = null;
        await publish(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
        recordedSnapshots = buildRecordedSnapshots(ctx);
        liveSnapshot = null;
        await publish(ctx);
    });

    pi.on("turn_end", async (_event, ctx) => {
        recordedSnapshots = buildRecordedSnapshots(ctx);
        liveSnapshot = null;
        await publish(ctx);
    });

    pi.on("model_select", async (_event, ctx) => {
        await publish(ctx);
    });

    pi.on("context", async (event, ctx) => {
        liveSnapshot = buildLiveSnapshot(event, ctx);
        await publish(ctx);
    });

    pi.on("session_shutdown", async () => {
        closeWindow();
    });

    function closeWindow() {
        if (windowRef) {
            windowRef.close();
        }
        windowRef = null;
        windowReady = false;
    }

    async function openOrRefreshWindow(ctx: ExtensionContext) {
        if (!windowRef) {
            const { open } = await import(pathToFileURL(GLIMPSE_PATH).href);
            lastPayload = buildPayload(ctx, recordedSnapshots, liveSnapshot);
            const win = open(renderHtml(lastPayload), {
                width: 1280,
                height: 760,
                title: WINDOW_TITLE,
            });

            windowRef = win as GlimpseWindow;
            windowReady = false;

            windowRef.on("ready", () => {
                windowReady = true;
                if (lastPayload && windowRef) {
                    windowRef.send(`window.updateChart(${JSON.stringify(lastPayload)})`);
                }
            });

            windowRef.on("closed", () => {
                windowRef = null;
                windowReady = false;
            });
            return;
        }

        await publish(ctx);
    }

    async function publish(ctx: ExtensionContext) {
        lastPayload = buildPayload(ctx, recordedSnapshots, liveSnapshot);
        if (!windowRef || !windowReady) return;
        windowRef.send(`window.updateChart(${JSON.stringify(lastPayload)})`);
    }
}

function buildRecordedSnapshots(ctx: ExtensionContext): Snapshot[] {
    const branch = ctx.sessionManager.getBranch();
    const entries = ctx.sessionManager.getEntries() as SessionEntry[];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const systemPrompt = ctx.getSystemPrompt() ?? "";
    const snapshots: Snapshot[] = [];
    let turn = 0;

    for (const entry of branch) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        turn += 1;
        const context = buildSessionContext(entries, entry.parentId ?? null, byId);
        snapshots.push({
            ...buildSnapshot(context.messages, systemPrompt, turn, "recorded"),
            timestamp: safeTimestamp(entry.timestamp),
        });
    }

    return snapshots;
}

function buildLiveSnapshot(event: ContextEvent, ctx: ExtensionContext): Snapshot {
    const branch = ctx.sessionManager.getBranch();
    const nextTurn = countAssistantMessages(branch) + 1;
    return buildSnapshot(event.messages, ctx.getSystemPrompt() ?? "", nextTurn, "live");
}

function buildSnapshot(messages: AgentMessage[], systemPrompt: string, turn: number, source: Snapshot["source"]): Snapshot {
    const snapshot: Snapshot = {
        version: EXTENSION_SNAPSHOT_VERSION,
        turn,
        systemInstructions: estimateTextTokens(systemPrompt),
        userInput: 0,
        agentOutput: 0,
        tools: 0,
        memory: 0,
        total: 0,
        source,
    };

    for (const message of messages) {
        const tokens = safeEstimateMessage(message);
        switch (message.role) {
            case "user":
                snapshot.userInput += tokens;
                break;
            case "assistant":
                snapshot.agentOutput += tokens;
                break;
            case "toolResult":
            case "bashExecution":
                snapshot.tools += tokens;
                break;
            case "compactionSummary":
            case "branchSummary":
            case "custom":
                snapshot.memory += tokens;
                break;
            default:
                snapshot.memory += tokens;
        }
    }

    snapshot.total =
        snapshot.systemInstructions +
        snapshot.userInput +
        snapshot.agentOutput +
        snapshot.tools +
        snapshot.memory;

    return snapshot;
}

function buildPayload(ctx: ExtensionContext, recordedSnapshots: Snapshot[], liveSnapshot: Snapshot | null): ChartPayload {
    const points = mergeSnapshots(recordedSnapshots, liveSnapshot);
    const usage = collectUsage(ctx);
    const current = liveSnapshot ?? buildCurrentContextSnapshot(ctx);
    const contextWindow = ctx.model?.contextWindow ?? null;
    const currentPercent = contextWindow && current.total > 0 ? (current.total / contextWindow) * 100 : null;

    return {
        points,
        meta: {
            model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
            sessionName: ctx.sessionManager.getSessionName() ?? null,
            sessionFile: ctx.sessionManager.getSessionFile() ?? null,
            contextWindow,
            currentTotal: current.total,
            currentPercent,
            usage,
            updatedAt: Date.now(),
        },
    };
}

function buildCurrentContextSnapshot(ctx: ExtensionContext): Snapshot {
    const entries = ctx.sessionManager.getEntries() as SessionEntry[];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const currentContext = buildSessionContext(entries, ctx.sessionManager.getLeafId(), byId);
    const currentTurn = countAssistantMessages(ctx.sessionManager.getBranch());
    return buildSnapshot(currentContext.messages, ctx.getSystemPrompt() ?? "", currentTurn, "recorded");
}

function mergeSnapshots(recorded: Snapshot[], live: Snapshot | null): Snapshot[] {
    const merged = [...recorded];
    if (live) {
        const index = merged.findIndex((point) => point.turn === live.turn);
        if (index >= 0) merged[index] = live;
        else merged.push(live);
    }
    return merged.sort((a, b) => a.turn - b.turn);
}

function collectUsage(ctx: ExtensionContext): UsageSummary {
    const usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const message = entry.message as AssistantMessage;
        usage.input += message.usage?.input ?? 0;
        usage.output += message.usage?.output ?? 0;
        usage.cacheRead += message.usage?.cacheRead ?? 0;
        usage.cacheWrite += message.usage?.cacheWrite ?? 0;
        usage.cost += message.usage?.cost?.total ?? 0;
    }

    return usage;
}

function countAssistantMessages(entries: SessionEntry[]): number {
    let count = 0;
    for (const entry of entries) {
        if (entry.type === "message" && entry.message.role === "assistant") count += 1;
    }
    return count;
}

function estimateTextTokens(text: string): number {
    if (!text.trim()) return 0;
    return safeEstimateMessage({ role: "user", content: text, timestamp: Date.now() } as AgentMessage);
}

function safeEstimateMessage(message: AgentMessage): number {
    try {
        return Math.max(0, estimateTokens(message));
    } catch {
        return Math.max(0, Math.ceil(extractText(message).length / 4));
    }
}

function extractText(message: AgentMessage): string {
    const parts: string[] = [message.role];
    const anyMessage = message as any;

    if (typeof anyMessage.content === "string") {
        parts.push(anyMessage.content);
    } else if (Array.isArray(anyMessage.content)) {
        for (const block of anyMessage.content) {
            if (block.type === "text") parts.push(block.text ?? "");
            else if (block.type === "thinking") parts.push(block.thinking ?? "");
            else if (block.type === "toolCall") parts.push(block.name ?? "", JSON.stringify(block.arguments ?? {}));
            else parts.push(JSON.stringify(block));
        }
    }

    for (const key of ["toolName", "summary", "command", "customType"]) {
        if (typeof anyMessage[key] === "string") parts.push(anyMessage[key]);
    }

    return parts.join("\n");
}

function safeTimestamp(timestamp: string): number | undefined {
    const value = Date.parse(timestamp);
    return Number.isFinite(value) ? value : undefined;
}

function renderHtml(initialPayload: ChartPayload): string {
    return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${WINDOW_TITLE}</title>
	<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
	<style>
		:root {
			color-scheme: light dark;
			--bg: #f5f4f0;
			--panel: #fff;
			--border: #d4d0c8;
			--text: #1a1a1a;
			--muted: #6b6b6b;
			--accent: #c25630;
		}
		@media (prefers-color-scheme: dark) {
			:root {
				--bg: #161616;
				--panel: #1e1e1e;
				--border: #333;
				--text: #e0ddd5;
				--muted: #888;
				--accent: #d4714a;
			}
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			padding: 20px 24px;
			font-family: 'IBM Plex Sans', -apple-system, sans-serif;
			background: var(--bg);
			color: var(--text);
		}
		.shell {
			display: flex;
			flex-direction: column;
			gap: 14px;
			height: calc(100vh - 40px);
		}
		.header {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 16px;
		}
		.badge {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			font-family: 'IBM Plex Mono', monospace;
			font-size: 11px;
			font-weight: 500;
			color: var(--muted);
			letter-spacing: 0.02em;
		}
		.live-dot {
			width: 6px;
			height: 6px;
			border-radius: 50%;
			background: var(--accent);
		}
		.title h1 {
			margin: 6px 0 4px;
			font-family: 'IBM Plex Sans', sans-serif;
			font-size: 20px;
			font-weight: 600;
			line-height: 1.2;
			letter-spacing: -0.01em;
		}
		.title p {
			margin: 0;
			color: var(--muted);
			font-size: 13px;
		}
		.stats {
			display: grid;
			grid-template-columns: repeat(4, minmax(120px, 1fr));
			gap: 1px;
			background: var(--border);
			border: 1px solid var(--border);
		}
		.card {
			padding: 12px 14px;
			background: var(--panel);
		}
		.card .label {
			display: block;
			font-family: 'IBM Plex Mono', monospace;
			font-size: 10px;
			font-weight: 500;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--muted);
			margin-bottom: 6px;
		}
		.card .value {
			font-family: 'IBM Plex Mono', monospace;
			font-size: 20px;
			font-weight: 600;
			letter-spacing: -0.02em;
		}
		.card .subvalue {
			margin-top: 4px;
			font-family: 'IBM Plex Mono', monospace;
			font-size: 11px;
			color: var(--muted);
		}
		.chart-shell {
			flex: 1;
			min-height: 320px;
			padding: 16px 16px 8px;
			background: var(--panel);
			border: 1px solid var(--border);
		}
		.canvas-wrap {
			position: relative;
			height: 100%;
			min-height: 320px;
		}
		.empty {
			display: none;
			position: absolute;
			inset: 0;
			align-items: center;
			justify-content: center;
			text-align: center;
			padding: 24px;
			color: var(--muted);
			font-size: 13px;
			font-family: 'IBM Plex Mono', monospace;
		}
		.footer {
			display: flex;
			justify-content: space-between;
			gap: 16px;
			color: var(--muted);
			font-family: 'IBM Plex Mono', monospace;
			font-size: 11px;
		}
		.footer span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		@media (max-width: 900px) {
			.header { flex-direction: column; }
			.stats { grid-template-columns: repeat(2, minmax(120px, 1fr)); width: 100%; }
		}
	</style>
</head>
<body>
	<div class="shell">
		<div class="header">
			<div class="title">
				<h1>Context usage by turn</h1>
				<p id="subtitle">Estimating prompt composition for each model request in the current branch.</p>
			</div>
			<div class="stats">
				<div class="card">
					<span class="label">Current context</span>
					<div class="value" id="currentTotal">—</div>
					<div class="subvalue" id="currentPercent">—</div>
				</div>
				<div class="card">
					<span class="label">Window</span>
					<div class="value" id="contextWindow">—</div>
					<div class="subvalue" id="modelName">—</div>
				</div>
				<div class="card">
					<span class="label">Session usage</span>
					<div class="value" id="sessionUsage">—</div>
					<div class="subvalue" id="sessionCost">—</div>
				</div>
				<div class="card">
					<span class="label">Turns</span>
					<div class="value" id="turnCount">0</div>
					<div class="subvalue" id="sessionName">—</div>
				</div>
			</div>
		</div>
		<div class="chart-shell">
			<div class="canvas-wrap">
				<canvas id="chart"></canvas>
				<div class="empty" id="emptyState">Open this window before or during a conversation to watch context accumulate turn by turn.</div>
			</div>
		</div>
		<div class="footer">
			<span id="sessionFile">No session file</span>
			<span id="updatedAt">Waiting for updates…</span>
		</div>
	</div>
	<script>
		const COLORS = {
			systemInstructions: { stroke: '#8c7a6b', fill: 'rgba(140,122,107,0.12)' },
			userInput: { stroke: '#5b8a72', fill: 'rgba(91,138,114,0.12)' },
			agentOutput: { stroke: '#c25630', fill: 'rgba(194,86,48,0.12)' },
			tools: { stroke: '#6882a8', fill: 'rgba(104,130,168,0.12)' },
			memory: { stroke: '#b5944f', fill: 'rgba(181,148,79,0.12)' },
		};

		const fmt = new Intl.NumberFormat();
		const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
		let chart;

		function formatTokens(value) {
			if (value == null || Number.isNaN(value)) return '—';
			if (Math.abs(value) >= 1000) return compactFmt.format(value).toLowerCase();
			return fmt.format(value);
		}

		function formatPercent(value) {
			if (value == null || Number.isNaN(value)) return '—';
			return value.toFixed(1) + '%';
		}

		function buildDatasets(points) {
			return [
				{ key: 'systemInstructions', label: 'System' },
				{ key: 'userInput', label: 'User' },
				{ key: 'agentOutput', label: 'Agent' },
				{ key: 'tools', label: 'Tools' },
				{ key: 'memory', label: 'Memory' },
			].map((item) => ({
				label: item.label,
				data: points.map((point) => point[item.key] || 0),
				fill: true,
				stack: 'tokens',
				borderColor: COLORS[item.key].stroke,
				backgroundColor: COLORS[item.key].fill,
				borderWidth: 1.5,
				pointRadius: 2,
				pointHoverRadius: 4,
				tension: 0.2,
			}));
		}

		function ensureChart() {
			if (typeof Chart === 'undefined') return null;
			if (chart) return chart;
			const ctx = document.getElementById('chart');
			const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
			const borderColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim();
			chart = new Chart(ctx, {
				type: 'line',
				data: { labels: [], datasets: [] },
				options: {
					animation: false,
					maintainAspectRatio: false,
					interaction: { mode: 'index', intersect: false },
					plugins: {
						legend: {
							position: 'top',
							align: 'end',
							labels: {
								boxWidth: 10,
								usePointStyle: true,
								pointStyle: 'rect',
								color: mutedColor,
								font: { family: "'IBM Plex Mono', monospace", size: 11 },
								padding: 16,
							},
						},
						tooltip: {
							backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim(),
							titleColor: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
							bodyColor: mutedColor,
							footerColor: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
							borderColor: borderColor,
							borderWidth: 1,
							titleFont: { family: "'IBM Plex Mono', monospace", size: 12, weight: '600' },
							bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
							footerFont: { family: "'IBM Plex Mono', monospace", size: 11, weight: '600' },
							padding: 10,
							cornerRadius: 0,
							displayColors: true,
							boxWidth: 8,
							boxHeight: 8,
							boxPadding: 4,
							callbacks: {
								title(items) {
									return 'Turn ' + items[0].label;
								},
								label(item) {
									return ' ' + item.dataset.label + '  ' + fmt.format(item.raw || 0);
								},
								footer(items) {
									const total = items.reduce((sum, item) => sum + (item.raw || 0), 0);
									return 'Total  ' + fmt.format(total);
								},
							},
						},
					},
					scales: {
						x: {
							stacked: true,
							title: { display: true, text: 'Turn', color: mutedColor, font: { family: "'IBM Plex Mono', monospace", size: 11 } },
							grid: { color: borderColor, lineWidth: 0.5 },
							ticks: { color: mutedColor, font: { family: "'IBM Plex Mono', monospace", size: 11 } },
							border: { color: borderColor },
						},
						y: {
							stacked: true,
							beginAtZero: true,
							title: { display: true, text: 'Tokens', color: mutedColor, font: { family: "'IBM Plex Mono', monospace", size: 11 } },
							grid: { color: borderColor, lineWidth: 0.5 },
							ticks: {
								color: mutedColor,
								font: { family: "'IBM Plex Mono', monospace", size: 11 },
								callback(value) { return formatTokens(Number(value)); },
							},
							border: { color: borderColor },
						},
					},
				},
			});
			return chart;
		}

		function updateMeta(payload) {
			document.getElementById('currentTotal').textContent = formatTokens(payload.meta.currentTotal);
			document.getElementById('currentPercent').textContent = payload.meta.contextWindow
				? formatPercent(payload.meta.currentPercent) + ' of ' + formatTokens(payload.meta.contextWindow)
				: 'No context window';
			document.getElementById('contextWindow').textContent = payload.meta.contextWindow ? formatTokens(payload.meta.contextWindow) : '—';
			document.getElementById('modelName').textContent = payload.meta.model || 'No model selected';
			document.getElementById('sessionUsage').textContent =
				'↑' + formatTokens(payload.meta.usage.input) + ' ↓' + formatTokens(payload.meta.usage.output);
			document.getElementById('sessionCost').textContent =
				'Cache R' + formatTokens(payload.meta.usage.cacheRead) + ' • W' + formatTokens(payload.meta.usage.cacheWrite) +
				(payload.meta.usage.cost > 0 ? ' • $' + payload.meta.usage.cost.toFixed(4) : '');
			document.getElementById('turnCount').textContent = String(payload.points.length);
			document.getElementById('sessionName').textContent = payload.meta.sessionName || 'Unnamed session';
			document.getElementById('sessionFile').textContent = payload.meta.sessionFile || 'In-memory session';
			document.getElementById('updatedAt').textContent = 'Updated ' + new Date(payload.meta.updatedAt).toLocaleTimeString();
			document.getElementById('subtitle').textContent =
				'Estimating prompt composition for each model request in the current branch.' +
				(payload.points.some((point) => point.source === 'live') ? ' Live point shown for the in-flight request.' : '');
		}

		window.updateChart = function updateChart(payload) {
			updateMeta(payload);
			const empty = document.getElementById('emptyState');
			const instance = ensureChart();
			if (!instance) {
				empty.style.display = 'flex';
				empty.textContent = 'Chart.js failed to load. Check network access, then reopen /context-chart.';
				return;
			}
			empty.style.display = payload.points.length === 0 ? 'flex' : 'none';
			instance.data.labels = payload.points.map((point) => String(point.turn));
			instance.data.datasets = buildDatasets(payload.points);
			instance.update();
		};

		window.updateChart(${JSON.stringify(initialPayload)});
	</script>
</body>
</html>`;
}
