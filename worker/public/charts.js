// The one shared chart helper, used by the assistant page and the Segments page.
// Chart.js is vendored at /vendor/chart.umd.min.js and loaded by a classic script tag before the page module.
// Charts are built from server data ({ type, labels, values, title }), never from model text.

const drawn = new WeakMap();

/** Destroys the chart on `canvas`, if any, and hides the canvas. */
export function clearChart(canvas) {
	const previous = drawn.get(canvas);
	if (previous) previous.destroy();
	drawn.delete(canvas);
	canvas.hidden = true;
}

/** Draws a bar or line chart (per `chart.type`, one colour, no fill) from `{ type, labels, values, title }`, replacing any chart already on the canvas. */
export function drawChart(canvas, chart) {
	clearChart(canvas);
	if (!window.Chart || chart.labels.length === 0) return;
	canvas.hidden = false;
	const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1f5fbf";
	const instance = new window.Chart(canvas, {
		type: chart.type,
		data: { labels: chart.labels, datasets: [{ label: chart.title, data: chart.values, backgroundColor: accent, borderColor: accent, maxBarThickness: 56, fill: false, tension: 0 }] },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			plugins: { legend: { display: false }, title: { display: true, text: chart.title } },
			scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
		},
	});
	drawn.set(canvas, instance);
}

/** Turns `[{ group, count }]` into the chart shape the server builds for assistant answers. */
export function groupsToChart(groups, title) {
	return { type: "bar", labels: groups.map((g) => g.group), values: groups.map((g) => g.count), title };
}
