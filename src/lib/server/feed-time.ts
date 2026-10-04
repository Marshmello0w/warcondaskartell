// Receipt validation and the persistent round-clock model. The game provides elapsed seconds,
// not UTC kill times; an anchor estimates UTC once per unambiguous clock, never once per POST.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ParsedBatch } from './feed-core';
import { ApiError } from './http';

export const FEED_HISTORY_MAX_MS = 30 * 86400_000;
export const FEED_FUTURE_MAX_MS = 2000;
export const FEED_LIVE_MAX_MS = 30_000;
// Normal game flushes are roughly two seconds apart. Outside this allowance we cannot tell
// transport buffering from another round with the same map/instance and must abstain.
export const FEED_CLOCK_SLOP_MS = 10_000;
const MAX_EVENT_SECONDS = 7 * 86400;

export interface FeedRelaySource {
	id: string;
	serverId: string;
	token: string;
}

export function parseFeedRelays(raw?: string): FeedRelaySource[] {
	if (!raw) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('FEED_RELAY_SOURCES must be a JSON array.');
	}
	if (!Array.isArray(value)) throw new Error('FEED_RELAY_SOURCES must be a JSON array.');
	const ids = new Set<string>();
	const tokens = new Set<string>();
	return value.map((v: unknown) => {
		const r = v as FeedRelaySource | null;
		if (
			!r ||
			typeof r.id !== 'string' ||
			r.id === 'direct' ||
			!/^[A-Za-z0-9_-]{1,64}$/.test(r.id) ||
			typeof r.serverId !== 'string' ||
			!r.serverId ||
			r.serverId.length > 64 ||
			typeof r.token !== 'string' ||
			!/^[A-Za-z0-9_-]{43,128}$/.test(r.token) ||
			ids.has(r.id) ||
			tokens.has(r.token)
		)
			throw new Error(
				'Invalid or duplicate FEED_RELAY_SOURCES entry (id, serverId, random base64url token of at least 43 characters required).'
			);
		ids.add(r.id);
		tokens.add(r.token);
		return { id: r.id, serverId: r.serverId, token: r.token };
	});
}

/** Strict RFC3339 subset: full date/time, optional 1–9 decimal places, Z or numeric UTC offset. */
export function parseSourceReceivedAt(value: unknown, now: Date): Date {
	const m =
		typeof value === 'string'
			? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
					value
				)
			: null;
	if (!m)
		throw new ApiError(
			400,
			'sourceReceivedAt must be an RFC3339 timestamp with a timezone.',
			'invalid_source_time'
		);
	const [, y, mo, d, h, mi, s, fraction, zone, sign, oh, om] = m;
	const year = Number(y),
		month = Number(mo),
		day = Number(d);
	const hour = Number(h),
		minute = Number(mi),
		second = Number(s);
	const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
	if (
		year < 2000 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > days ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		(zone !== 'Z' &&
			(Number(oh) > 14 || Number(om) > 59 || (Number(oh) === 14 && Number(om) !== 0))) ||
		zone === '-00:00'
	)
		throw new ApiError(
			400,
			'sourceReceivedAt is not a valid calendar time/UTC offset.',
			'invalid_source_time'
		);
	const offset = zone === 'Z' ? 0 : (Number(oh) * 60 + Number(om)) * (sign === '+' ? 1 : -1);
	// JS and UI precision is milliseconds. Keep the original string separately for provenance.
	const ms =
		Date.UTC(
			year,
			month - 1,
			day,
			hour,
			minute,
			second,
			Number((fraction ?? '').padEnd(3, '0').slice(0, 3))
		) -
		offset * 60_000;
	if (ms > now.getTime() + FEED_FUTURE_MAX_MS)
		throw new ApiError(
			400,
			'sourceReceivedAt is more than 2 seconds in the future.',
			'future_source_time'
		);
	if (ms < now.getTime() - FEED_HISTORY_MAX_MS)
		throw new ApiError(
			400,
			'sourceReceivedAt is older than the 30-day relay acceptance window.',
			'stale_source_time'
		);
	return new Date(ms);
}

export interface FeedReceipt {
	packetReceivedAt: Date;
	warconReceivedAt: Date;
	sourceReceivedAt: string | null;
	relaySourceId: string | null;
}

export function feedReceipt(
	config: string | undefined,
	serverId: string,
	body: unknown,
	now: Date,
	relayToken?: string | null
): FeedReceipt {
	const events = body && typeof body === 'object' ? (body as { events?: unknown }).events : null;
	if (
		Array.isArray(events) &&
		events.some((e) => e && typeof e === 'object' && Object.hasOwn(e, 'sourceReceivedAt'))
	)
		throw new ApiError(
			400,
			'sourceReceivedAt belongs at the packet top level, not inside an event.',
			'misplaced_source_time'
		);
	const hasSource = !!body && typeof body === 'object' && Object.hasOwn(body, 'sourceReceivedAt');
	if (!hasSource && !relayToken)
		return {
			packetReceivedAt: now,
			warconReceivedAt: now,
			sourceReceivedAt: null,
			relaySourceId: null
		};
	const digest = (s: string) => createHash('sha256').update(s).digest();
	const supplied = digest(relayToken ?? '');
	const source = parseFeedRelays(config).find(
		(r) => timingSafeEqual(digest(r.token), supplied) && r.serverId === serverId
	);
	if (!source)
		throw new ApiError(
			403,
			'sourceReceivedAt requires an explicitly configured relay token for this server.',
			'untrusted_feed_relay'
		);
	if (!hasSource)
		throw new ApiError(
			400,
			'Authenticated relay packets require sourceReceivedAt.',
			'missing_source_time'
		);
	const raw = (body as { sourceReceivedAt: unknown }).sourceReceivedAt;
	return {
		packetReceivedAt: parseSourceReceivedAt(raw, now),
		warconReceivedAt: now,
		sourceReceivedAt: raw as string,
		relaySourceId: source.id
	};
}

export interface FeedClock {
	id: string;
	instanceId: string;
	sourceId: string;
	map: string;
	matchRow: number | null;
	firstReceiptAt: Date;
	lastReceiptAt: Date;
	endedAt: Date | null;
	anchorAt: Date | null;
	maxEventTime: number;
}

export interface ClockResolution {
	clock: FeedClock | null;
	create: boolean;
	close: string | null;
	reason: string | null;
}

/** Clocks are loaded under the per-server transaction lock. matchId deliberately plays no part. */
export function resolveFeedClock(
	clocks: FeedClock[],
	batch: ParsedBatch,
	receipt: FeedReceipt,
	matchRow: number | null,
	newId: string,
	observedEndAt: Date | null = null
): ClockResolution {
	const at = receipt.packetReceivedAt.getTime();
	const sourceId = receipt.relaySourceId ?? 'direct';
	const times = batch.kills.map((k) => k.eventTime);
	const map = batch.kills[0]?.map;
	const latest = Math.max(...times);
	const head = [...clocks].sort((a, b) => b.lastReceiptAt.getTime() - a.lastReceiptAt.getTime())[0];
	const unknown = (reason: string, close: string | null = null): ClockResolution => ({
		clock: null,
		create: false,
		close,
		reason
	});
	if (!times.length) return unknown('empty');
	if (!batch.instanceId || !map || times.some((t) => t < 0 || t > MAX_EVENT_SECONDS))
		return unknown('invalid_clock');
	// A packet can cross a map change or reset; its single receipt does not locate either clock.
	const mixedMaps = batch.kills.some((k) => k.map !== map);
	const resetInside = times.some((t, i) => i > 0 && t < times[i - 1] - 0.01);
	if (mixedMaps || resetInside) {
		const close = head && !head.endedAt && at >= head.lastReceiptAt.getTime() ? head.id : null;
		if (!mixedMaps && resetInside && (!head || at >= head.lastReceiptAt.getTime()))
			return {
				clock: {
					id: newId,
					instanceId: batch.instanceId,
					sourceId,
					map,
					matchRow,
					firstReceiptAt: new Date(at),
					lastReceiptAt: new Date(at),
					endedAt: observedEndAt,
					anchorAt: null,
					maxEventTime: times.at(-1)!
				},
				create: true,
				close,
				reason: 'mixed_round_packet'
			};
		return unknown('mixed_round_packet', close);
	}
	const same = clocks.filter(
		(c) => c.instanceId === batch.instanceId && c.sourceId === sourceId && c.map === map
	);
	const candidates = same.filter((c) => {
		if (!c.anchorAt || (matchRow !== null && c.matchRow !== null && c.matchRow !== matchRow))
			return false;
		if (c.endedAt && at >= c.endedAt.getTime()) return false;
		// firstReceiptAt is the first packet seen, not a proven start of the round. Earlier
		// originals may extend this clock backwards when projection/map/boot uniquely agree.
		const projected = c.anchorAt.getTime() + latest * 1000;
		return projected <= at + FEED_FUTURE_MAX_MS && projected >= at - FEED_CLOCK_SLOP_MS;
	});
	if (candidates.length === 1) {
		const c = candidates[0];
		return {
			clock: {
				...c,
				endedAt: c.endedAt ?? observedEndAt,
				matchRow: c.matchRow ?? matchRow,
				lastReceiptAt: new Date(Math.max(at, c.lastReceiptAt.getTime())),
				maxEventTime: Math.max(latest, c.maxEventTime)
			},
			create: false,
			close: null,
			reason: null
		};
	}
	if (candidates.length > 1) return unknown('multiple_rounds');
	if (head && at <= head.lastReceiptAt.getTime()) {
		if (
			matchRow !== null &&
			matchRow !== head.matchRow &&
			!same.some((c) => c.matchRow === matchRow) &&
			observedEndAt &&
			at < observedEndAt.getTime()
		)
			return {
				clock: {
					id: newId,
					instanceId: batch.instanceId,
					sourceId,
					map,
					matchRow,
					firstReceiptAt: new Date(at),
					lastReceiptAt: new Date(at),
					endedAt: observedEndAt,
					anchorAt: new Date(at - latest * 1000),
					maxEventTime: latest
				},
				create: true,
				close: null,
				reason: null
			};
		return unknown('unassigned_older_packet');
	}
	const boundary =
		!head ||
		head.instanceId !== batch.instanceId ||
		head.sourceId !== sourceId ||
		head.map !== map ||
		(matchRow !== null && head.matchRow !== null && matchRow !== head.matchRow);
	if (!boundary) {
		// A same-map reset with no independently observed round boundary is also consistent with
		// buffering inside the game. Persist uncertainty so subsequent packets cannot reuse the
		// old anchor or invent a new one until a map/boot/observed-round boundary resolves it.
		if (head.anchorAt && latest < head.maxEventTime - 2) {
			return {
				clock: {
					id: newId,
					instanceId: batch.instanceId,
					sourceId,
					map,
					matchRow,
					firstReceiptAt: new Date(at),
					lastReceiptAt: new Date(at),
					endedAt: null,
					anchorAt: null,
					maxEventTime: latest
				},
				create: true,
				close: head.endedAt ? null : head.id,
				reason: 'unobserved_reset'
			};
		}
		return unknown(head.anchorAt ? 'inconsistent_clock' : 'unobserved_reset');
	}
	const anchor = at - latest * 1000;
	const overlaps =
		!!head &&
		head.sourceId === sourceId &&
		anchor < head.lastReceiptAt.getTime() - FEED_CLOCK_SLOP_MS;
	return {
		clock: {
			id: newId,
			instanceId: batch.instanceId,
			sourceId,
			map,
			matchRow,
			firstReceiptAt: new Date(at),
			lastReceiptAt: new Date(at),
			endedAt: observedEndAt,
			anchorAt: overlaps ? null : new Date(anchor),
			maxEventTime: latest
		},
		create: true,
		close: head?.endedAt ? null : (head?.id ?? null),
		reason: overlaps ? 'overlapping_round_clock' : null
	};
}

export function stampFeedKill(receipt: FeedReceipt, clock: FeedClock | null, eventTime: number) {
	const eventAt = clock?.anchorAt ? new Date(clock.anchorAt.getTime() + eventTime * 1000) : null;
	const now = receipt.warconReceivedAt.getTime();
	const historical =
		clock?.endedAt != null ||
		now - receipt.packetReceivedAt.getTime() > FEED_LIVE_MAX_MS ||
		(eventAt !== null && now - eventAt.getTime() > FEED_LIVE_MAX_MS);
	return {
		ts: eventAt ?? receipt.packetReceivedAt,
		eventAt,
		timeQuality: eventAt ? 'clock' : 'ambiguous',
		historical,
		moderationEligible:
			!!eventAt && !clock?.endedAt && !historical && eventAt.getTime() <= now + FEED_FUTURE_MAX_MS,
		clockId: clock?.id ?? null
	};
}
