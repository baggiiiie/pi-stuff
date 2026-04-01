import type { ChartPayload } from "./data.ts";

const WINDOW_TITLE = "Session Context Usage";
const SANS_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO_FONT = 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export function renderHtml(initialPayload: ChartPayload): string {
    return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${WINDOW_TITLE}</title>
	<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
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
			font-family: ${SANS_FONT};
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
			font-family: ${MONO_FONT};
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
			font-family: ${SANS_FONT};
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
			font-family: ${MONO_FONT};
			font-size: 10px;
			font-weight: 500;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--muted);
			margin-bottom: 6px;
		}
		.card .value {
			font-family: ${MONO_FONT};
			font-size: 20px;
			font-weight: 600;
			letter-spacing: -0.02em;
		}
		.card .subvalue {
			margin-top: 4px;
			font-family: ${MONO_FONT};
			font-size: 11px;
			color: var(--muted);
		}
		.chart-shell {
			flex: 1;
			min-height: 320px;
			padding: 16px;
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
			font-family: ${MONO_FONT};
		}
		.chart-toggle {
			display: inline-flex;
			border: 1px solid var(--border);
			background: var(--panel);
			overflow: hidden;
		}
		.chart-toggle button {
			all: unset;
			padding: 4px 10px;
			font-family: ${MONO_FONT};
			font-size: 11px;
			color: var(--muted);
			cursor: pointer;
			border-right: 1px solid var(--border);
		}
		.chart-toggle button:last-child { border-right: none; }
		.chart-toggle button.active {
			background: var(--accent);
			color: #fff;
		}
		.footer {
			display: flex;
			justify-content: space-between;
			gap: 16px;
			color: var(--muted);
			font-family: ${MONO_FONT};
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
			<div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
				<div class="chart-toggle">
					<button id="btnLine" class="active" onclick="setChartType('line')">Line</button>
					<button id="btnBar" onclick="setChartType('bar')">Bar</button>
				</div>
			</div>
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
		let currentPayload = null;
		let chartType = 'line';

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
			const isBar = chartType === 'bar';
			return [
				{ key: 'systemInstructions', label: 'System' },
				{ key: 'userInput', label: 'User' },
				{ key: 'agentOutput', label: 'Agent' },
				{ key: 'tools', label: 'Tools' },
				{ key: 'memory', label: 'Memory' },
			].map((item) => {
				return {
					label: item.label,
					data: points.map((point, i) => {
						const val = point[item.key] || 0;
						if (!isBar) return val;
						const prev = i > 0 ? (points[i - 1][item.key] || 0) : 0;
						return Math.max(0, val - prev);
					}),
					fill: !isBar,
					stack: isBar ? undefined : 'tokens',
					borderColor: COLORS[item.key].stroke,
					backgroundColor: isBar ? COLORS[item.key].stroke + 'cc' : COLORS[item.key].fill,
					borderWidth: isBar ? 1 : 1.5,
					pointRadius: isBar ? 0 : 2,
					pointHoverRadius: isBar ? 0 : 4,
					tension: 0.2,
				};
			});
		}

		function ensureChart() {
			if (typeof Chart === 'undefined') return null;
			if (chart && chart._appType === chartType) return chart;
			if (chart) { chart.destroy(); chart = null; }
			const ctx = document.getElementById('chart');
			const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
			const borderColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim();
			chart = new Chart(ctx, {
				type: chartType,
				data: { labels: [], datasets: [] },
				options: {
					animation: false,
					maintainAspectRatio: false,
					layout: { padding: { bottom: 16 } },
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
								font: { family: ${JSON.stringify(MONO_FONT)}, size: 11 },
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
							titleFont: { family: ${JSON.stringify(MONO_FONT)}, size: 12, weight: '600' },
							bodyFont: { family: ${JSON.stringify(MONO_FONT)}, size: 11 },
							footerFont: { family: ${JSON.stringify(MONO_FONT)}, size: 11, weight: '600' },
							padding: 10,
							titleMarginBottom: 6,
							cornerRadius: 0,
							displayColors: true,
							boxWidth: 8,
							boxHeight: 8,
							boxPadding: 4,
							callbacks: {
								title(items) {
									const point = currentPayload?.points[items[0].dataIndex];
									const lines = ['Turn ' + items[0].label];
									if (point?.turnLabel) lines.push(point.turnLabel);
									return lines;
								},
								afterTitle(items) {
									const point = currentPayload?.points[items[0].dataIndex];
									return point?.summary || '';
								},
								label(item) {
									return ' ' + item.dataset.label + '  ' + fmt.format(item.raw || 0);
								},
								footer(items) {
									const total = items.reduce((sum, item) => sum + (item.raw || 0), 0);
									return (chartType === 'bar' ? 'Total added  ' : 'Total  ') + fmt.format(total);
								},
							},
						},
					},
					scales: {
						x: {
							stacked: chartType === 'line',
							title: { display: true, text: 'Turn', color: mutedColor, font: { family: ${JSON.stringify(MONO_FONT)}, size: 11 } },
							grid: { color: borderColor, lineWidth: 0.5 },
							ticks: { color: mutedColor, font: { family: ${JSON.stringify(MONO_FONT)}, size: 11 } },
							border: { color: borderColor },
						},
						y: {
							stacked: chartType === 'line',
							beginAtZero: true,
							title: { display: true, text: 'Tokens', color: mutedColor, font: { family: ${JSON.stringify(MONO_FONT)}, size: 11 } },
							grid: { color: borderColor, lineWidth: 0.5 },
							ticks: {
								color: mutedColor,
								font: { family: ${JSON.stringify(MONO_FONT)}, size: 11 },
								callback(value) { return formatTokens(Number(value)); },
							},
							border: { color: borderColor },
						},
					},
				},
			});
			chart._appType = chartType;
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

		window.setChartType = function setChartType(type) {
			chartType = type;
			document.getElementById('btnLine').classList.toggle('active', type === 'line');
			document.getElementById('btnBar').classList.toggle('active', type === 'bar');
			if (currentPayload) window.updateChart(currentPayload);
		};

		window.updateChart = function updateChart(payload) {
			currentPayload = payload;
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
