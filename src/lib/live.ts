// Browser side of the live view: an event stream from the worker for the servers on the page,
// with a slow safety poll behind it. The stream is closed while the tab is hidden (which also
// lets the server drop out of the watched tier) and reopened when it comes back.
import { api } from './api';
import { noteLive } from './health.svelte';
import type { KillView, LiveView } from './types';

export interface OutboxNotice {
	serverId: string;
	id: number;
	state: string;
}
export interface KillsNotice {
	serverId: string;
	kills: KillView[];
}

const SAFETY_POLL_MS = 20_000;
/** Open streams per server id, so the header knows when it need not read for itself. */
const streamed = new Map<string, number>();

async function readLive(query: string): Promise<LiveView[]> {
	const d = await api<{ live: Record<string, LiveView> }>('GET', `/api/live?${query}`);
	return Object.values(d.live);
}

/**
 * How a page that lists a whole fleet asks for it. `org` names the servers instead of listing
 * them (null: every server the user may see), since hundreds of ids do not fit in a URL; the
 * stream is passive, so the servers keep the cadence their players give them rather than all
 * becoming watched, and slim: no player lists, no kills or rule deliveries.
 */
export interface FleetWatch {
	org: string | null;
	/** keep the player lists (a page that shows who is on) */
	players?: boolean;
}

export function watchLive(
	ids: string[],
	onEach: (v: LiveView) => void,
	onOutbox?: (n: OutboxNotice) => void,
	onKills?: (n: KillsNotice) => void,
	fleet?: FleetWatch
): () => void {
	if (!ids.length) return () => {};
	const onLive = (v: LiveView) => {
		noteLive(v);
		onEach(v);
	};
	const query = fleet
		? [
				fleet.org ? `org=${encodeURIComponent(fleet.org)}` : '',
				'passive=1',
				fleet.players ? '' : 'slim=1'
			]
				.filter(Boolean)
				.join('&')
		: `ids=${encodeURIComponent(ids.join(','))}`;
	let source: EventSource | null = null;
	let stopped = false;
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	for (const id of ids) streamed.set(id, (streamed.get(id) ?? 0) + 1);

	const poll = async () => {
		if (stopped || document.hidden) return;
		try {
			for (const v of await readLive(query)) onLive(v);
		} catch {
			/* the stream carries on */
		}
	};
	const open = () => {
		if (stopped || source) return;
		source = new EventSource(`/api/live/events?${query}`);
		source.addEventListener('live', (e) => onLive(JSON.parse((e as MessageEvent).data)));
		if (onOutbox)
			source.addEventListener('outbox', (e) => onOutbox(JSON.parse((e as MessageEvent).data)));
		if (onKills)
			source.addEventListener('kills', (e) => onKills(JSON.parse((e as MessageEvent).data)));
		// On error the browser reconnects by itself; the safety poll covers the gap.
	};
	const close = () => {
		source?.close();
		source = null;
	};
	const onVis = () => {
		if (document.hidden) close();
		else {
			open();
			void poll();
		}
	};
	if (!document.hidden) open();
	else void 0;
	pollTimer = setInterval(() => void poll(), SAFETY_POLL_MS);
	document.addEventListener('visibilitychange', onVis);
	return () => {
		stopped = true;
		for (const id of ids) {
			const n = (streamed.get(id) ?? 1) - 1;
			if (n > 0) streamed.set(id, n);
			else streamed.delete(id);
		}
		close();
		clearInterval(pollTimer);
		document.removeEventListener('visibilitychange', onVis);
	};
}

/**
 * Keeps one server's header current on a page that streams nothing: the worker's last look every
 * SAFETY_POLL_MS, skipped while a stream of that server is open. A plain read, unlike the stream,
 * so it never moves the server into the watched tier.
 */
export function followLive(id: string): () => void {
	const query = `ids=${encodeURIComponent(id)}`;
	const timer = setInterval(async () => {
		if (document.hidden || streamed.has(id)) return;
		try {
			for (const v of await readLive(query)) noteLive(v);
		} catch {
			/* the next round reads again */
		}
	}, SAFETY_POLL_MS);
	return () => clearInterval(timer);
}
