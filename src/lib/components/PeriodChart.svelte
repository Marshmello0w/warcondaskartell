<script lang="ts" module>
	export interface PeriodSeries<T> {
		key: string;
		label: string;
		color: string;
		/** null when the period has no value (no bar), which is not zero */
		value: (p: T) => number | null;
	}

	/**
	 * A period by name in the zone it was cut in: "Thu 1 Oct" or "Thu 14:00", and on an axis
	 * "1 Oct" or "14:00".
	 */
	export function periodName(ts: string, unit: 'hour' | 'day', tz: string, short = false): string {
		const d = new Date(ts);
		const zone = { timeZone: tz, ...(short ? {} : { weekday: 'short' as const }) };
		try {
			return unit === 'hour'
				? d.toLocaleString(undefined, { ...zone, hour: '2-digit', minute: '2-digit' })
				: d.toLocaleDateString(undefined, { ...zone, month: 'short', day: 'numeric' });
		} catch {
			return d.toLocaleString();
		}
	}
</script>

<script lang="ts" generics="P extends { ts: string }">
	// One bar per hour or day, a single series or a stack of them (bottom up in the order given;
	// the legend and the tooltip read top down). The last period is the one running now and is
	// drawn lighter. What counts as nothing to show is the caller's to say: a session of no length
	// is still a session.
	let {
		points,
		series,
		unit,
		tz,
		format,
		tip = format,
		totalLabel = '',
		steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000],
		rows = () => [],
		label
	}: {
		points: P[];
		series: PeriodSeries<P>[];
		unit: 'hour' | 'day';
		/** the zone the periods were cut in, for their labels */
		tz: string;
		/** a value as the axis shows it */
		format: (v: number) => string;
		/** a value as the tooltip shows it */
		tip?: (v: number) => string;
		/** what a stack adds up to, for the tooltip's first line */
		totalLabel?: string;
		/** the tick spacings to choose from, smallest first */
		steps?: number[];
		/** more lines for a period's tooltip, value then label */
		rows?: (p: P) => [string, string][];
		label: string;
	} = $props();

	let width = $state(0);
	let W = $derived(Math.max(320, width || 900));
	const H = 220;
	const PAD = { l: 46, r: 12, t: 12, b: 26 };
	let hover = $state<number | null>(null);
	let svg = $state<SVGSVGElement>();

	const total = (p: P) => series.reduce((n, s) => n + (s.value(p) ?? 0), 0);
	let max = $derived(Math.max(0, ...points.map(total)));
	// The smallest spacing that keeps the axis to five ticks or fewer.
	let step = $derived(steps.find((s) => max / s <= 4) ?? steps[steps.length - 1]);
	let top = $derived(Math.max(step, Math.ceil(max / step) * step));
	let ticks = $derived(Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step));

	let slot = $derived((W - PAD.l - PAD.r) / Math.max(1, points.length));
	let barW = $derived(Math.max(2, Math.min(24, slot - 2)));
	const cx = (i: number) => PAD.l + slot * (i + 0.5);
	const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);

	/** A bar's segment as a path: square at the bottom, the top rounded when it ends the bar. */
	function segment(x0: number, y0: number, y1: number, round: boolean): string {
		const x1 = x0 + barW;
		const r = round ? Math.min(4, barW / 2, y1 - y0) : 0;
		return `M${x0},${y1} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x1 - r} Q${x1},${y0} ${x1},${y0 + r} V${y1} Z`;
	}
	// Derived rather than computed in the markup, so the bars follow the points and the width.
	let bars = $derived(
		points.map((p, i) => {
			const x0 = cx(i) - barW / 2;
			const parts: { key: string; color: string; d: string }[] = [];
			let base = 0;
			const shown = series.filter((s) => (s.value(p) ?? 0) > 0);
			shown.forEach((s, j) => {
				const v = s.value(p) ?? 0;
				// A 2px gap in the panel colour between stacked parts, taken from the upper one.
				const bottom = y(base) - (j > 0 ? 2 : 0);
				const topY = Math.min(bottom - 1, y(base + v));
				parts.push({
					key: s.key,
					color: s.color,
					d: segment(x0, topY, bottom, j === shown.length - 1)
				});
				base += v;
			});
			return parts;
		})
	);

	// Labels at least 64px apart, counted back from the period running now so it always has one.
	let every = $derived(Math.max(1, Math.ceil(64 / slot)));
	let xTicks = $derived(
		points.flatMap((p, i) =>
			(points.length - 1 - i) % every ? [] : [{ i, label: periodName(p.ts, unit, tz, true) }]
		)
	);

	function onmove(e: MouseEvent) {
		if (!svg || !points.length) return;
		const rect = svg.getBoundingClientRect();
		const px = ((e.clientX - rect.left) / rect.width) * W;
		hover = Math.max(0, Math.min(points.length - 1, Math.floor((px - PAD.l) / slot)));
	}
	const running = (i: number) => i === points.length - 1;
	/** Where the tooltip's middle goes: over the bar, but never past the chart's edges. */
	const tipLeft = (i: number) => {
		const shown = width || W;
		return Math.min(shown - 90, Math.max(90, (cx(i) / W) * shown));
	};
</script>

{#if series.length > 1}
	<div class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-mist-400">
		{#each [...series].reverse() as s (s.key)}
			<span class="inline-flex items-center gap-1.5"
				><span class="inline-block h-2.5 w-2.5 rounded-[2px]" style="background:{s.color}"
				></span>{s.label}</span
			>
		{/each}
	</div>
{/if}
<div class="relative" bind:clientWidth={width}>
	<svg
		bind:this={svg}
		viewBox="0 0 {W} {H}"
		class="block h-auto w-full"
		role="img"
		aria-label={label}
		onmousemove={onmove}
		onmouseleave={() => (hover = null)}
	>
		{#each ticks as v (v)}
			<line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="rgb(255 255 255 / 0.07)" />
			<text
				x={PAD.l - 6}
				y={y(v) + 3.5}
				text-anchor="end"
				font-size="10"
				fill="#8a8a90"
				font-family="JetBrains Mono Variable, monospace">{format(v)}</text
			>
		{/each}
		{#each xTicks as t (t.i)}
			<text
				x={cx(t.i)}
				y={H - 8}
				text-anchor="middle"
				font-size="10"
				fill="#8a8a90"
				font-family="Barlow, sans-serif">{t.label}</text
			>
		{/each}
		{#if hover !== null}
			<rect
				x={cx(hover) - slot / 2}
				y={PAD.t}
				width={slot}
				height={H - PAD.t - PAD.b}
				fill="rgb(255 255 255 / 0.05)"
			/>
		{/if}
		{#each bars as parts, i (points[i].ts)}
			<g opacity={running(i) ? 0.5 : 1}>
				{#each parts as part (part.key)}
					<path d={part.d} fill={part.color} />
				{/each}
			</g>
		{/each}
	</svg>
	{#if hover !== null}
		{@const p = points[hover]}
		<div
			class="pointer-events-none absolute top-2 min-w-[140px] rounded-ctl border border-black bg-ink-800 px-2.5 py-1.5 text-[12px] shadow-pop"
			style="left:{tipLeft(hover)}px; transform:translateX(-50%)"
		>
			<div class="font-mono whitespace-nowrap text-mist-400">
				{periodName(p.ts, unit, tz)}{#if running(hover)}&nbsp;· so far{/if}
			</div>
			{#if series.length > 1}
				<div>
					<b class="tabular">{tip(total(p))}</b> <span class="text-mist-400">{totalLabel}</span>
				</div>
			{/if}
			{#each [...series].reverse() as s (s.key)}
				{@const v = s.value(p)}
				<div class="flex items-center gap-1.5">
					<span class="inline-block h-0.5 w-2.5" style="background:{s.color}"></span>
					<b class="tabular">{v === null ? '—' : tip(v)}</b>
					<span class="text-mist-400">{s.label.toLowerCase()}</span>
				</div>
			{/each}
			{#each rows(p) as [value, what] (what)}
				<div><b class="tabular">{value}</b> <span class="text-mist-400">{what}</span></div>
			{/each}
		</div>
	{/if}
</div>
