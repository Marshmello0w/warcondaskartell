import { describe, expect, test } from 'bun:test';
import { parseBatch } from './feed-core';
import {
	feedReceipt,
	parseFeedRelays,
	parseSourceReceivedAt,
	resolveFeedClock,
	stampFeedKill,
	type FeedClock,
	type FeedReceipt
} from './feed-time';
import { killRateReplay, type KillRateConfig } from './kill-rate';

const NOW = new Date('2026-10-04T15:30:00.000Z');
const TOKEN = 'R'.repeat(43);
const CONFIG = JSON.stringify([{ id: 'bot', serverId: 'warcon', token: TOKEN }]);
const receipt = (at: string, now = NOW): FeedReceipt => ({
	packetReceivedAt: new Date(at),
	warconReceivedAt: now,
	sourceReceivedAt: at,
	relaySourceId: 'bot'
});
const batch = (times: number[], instanceId = 'boot', maps: string[] = []) =>
	parseBatch({
		serverId: instanceId,
		events: times.map((eventTime, i) => ({
			type: 'killed',
			eventId: `e${i}`,
			eventTime,
			matchId: 'unchanged-across-rounds',
			mapName: maps[i] ?? 'Kavkazi',
			victimSteamId: '76561198000000002'
		}))
	});
const clock = (at = '2026-10-04T15:00:00.000Z', t = 100, matchRow: number | null = null) =>
	resolveFeedClock([], batch([t]), receipt(at), matchRow, 'clock-a').clock!;

describe('trusted source receipt', () => {
	test('a timestamp inside an event is rejected rather than mistaken for a direct feed', () => {
		expect(() =>
			feedReceipt(
				CONFIG,
				'warcon',
				{ events: [{ sourceReceivedAt: '2026-10-04T15:24:56Z' }] },
				NOW,
				TOKEN
			)
		).toThrow('top level');
	});
	test('direct packets keep actual receipt and need no relay configuration', () => {
		expect(feedReceipt(undefined, 'warcon', {}, NOW)).toEqual({
			packetReceivedAt: NOW,
			warconReceivedAt: NOW,
			sourceReceivedAt: null,
			relaySourceId: null
		});
	});
	test('the original microsecond string is preserved; UTC calculations use milliseconds', () => {
		const raw = '2026-10-04T15:24:56.665091Z';
		const r = feedReceipt(CONFIG, 'warcon', { sourceReceivedAt: raw }, NOW, TOKEN);
		expect(r.sourceReceivedAt).toBe(raw);
		expect(r.packetReceivedAt.toISOString()).toBe('2026-10-04T15:24:56.665Z');
		expect(r.warconReceivedAt).toEqual(NOW);
		expect(r.relaySourceId).toBe('bot');
	});
	test.each([
		'2026-10-04T17:24:56.665091+02:00',
		'2026-10-04T11:24:56.665091-04:00',
		'2026-10-04T15:24:56.665091000Z'
	])('accepts an explicit timezone: %s', (raw) => {
		expect(parseSourceReceivedAt(raw, NOW).toISOString()).toBe('2026-10-04T15:24:56.665Z');
	});
	test.each([
		null,
		1791127496,
		'',
		'2026-10-04',
		'2026-10-04T15:24:56',
		'2026-10-04 15:24:56Z',
		'2026-02-30T00:00:00Z',
		'2026-10-04T24:00:00Z',
		'2026-10-04T15:24:60Z',
		'2026-10-04T15:24:56+14:01',
		'2026-10-04T15:24:56-00:00',
		'2026-10-04T15:24:56.1234567890Z'
	])('rejects invalid source time instead of falling back: %s', (raw) => {
		expect(() => feedReceipt(CONFIG, 'warcon', { sourceReceivedAt: raw }, NOW, TOKEN)).toThrow();
	});
	test('requires both a configured relay and its independent server-scoped credential', () => {
		const b = { sourceReceivedAt: '2026-10-04T15:24:56Z' };
		for (const [config, server, token] of [
			[undefined, 'warcon', TOKEN],
			[CONFIG, 'other', TOKEN],
			[CONFIG, 'warcon', 'wrong'],
			[CONFIG, 'warcon', undefined]
		] as const)
			expect(() => feedReceipt(config, server, b, NOW, token)).toThrow('configured relay');
		expect(() => feedReceipt(CONFIG, 'warcon', {}, NOW, TOKEN)).toThrow('require sourceReceivedAt');
	});
	test('future tolerance is bounded and an old packet is explicitly rejected', () => {
		expect(parseSourceReceivedAt('2026-10-04T15:30:02Z', NOW).getTime()).toBe(NOW.getTime() + 2000);
		expect(() => parseSourceReceivedAt('2026-10-04T15:30:02.001Z', NOW)).toThrow('future');
		expect(() => parseSourceReceivedAt('2026-09-04T15:29:59Z', NOW)).toThrow('30-day');
	});
	test.each([
		'{}',
		'{',
		'[{"id":"bot","serverId":"warcon","token":"short"}]',
		JSON.stringify([
			{ id: 'a', serverId: 'x', token: TOKEN },
			{ id: 'b', serverId: 'y', token: TOKEN }
		])
	])('rejects bad relay configuration without exposing secrets', (raw) => {
		expect(() => parseFeedRelays(raw)).toThrow('FEED_RELAY_SOURCES');
	});
});

describe('durable feed clocks', () => {
	test('a mixed same-map reset cannot silently reanchor its next packet', () => {
		const old = clock('2026-10-04T15:00:00Z', 1000, 1);
		const r = receipt('2026-10-04T15:00:10Z');
		const mixed = resolveFeedClock([old], batch([1010, 2]), r, 1, 'uncertain');
		expect(mixed.clock?.anchorAt).toBeNull();
		const next = resolveFeedClock(
			[{ ...old, endedAt: r.packetReceivedAt }, mixed.clock!],
			batch([4]),
			receipt('2026-10-04T15:00:12Z'),
			1,
			'unused'
		);
		expect(next.clock).toBeNull();
		expect(next.reason).toBe('unobserved_reset');
	});
	test('a closed same-map clock needs a new observed round, boot or map before anchoring again', () => {
		const old = {
			...clock('2026-10-04T15:00:00Z', 1, 1),
			endedAt: new Date('2026-10-04T15:00:01Z')
		};
		const r = resolveFeedClock([old], batch([2]), receipt('2026-10-04T15:00:02Z'), null, 'unused');
		expect(r.clock).toBeNull();
		expect(r.reason).toBe('inconsistent_clock');
	});
	test('a reset/map boundary whose origin overlaps the previous round remains ambiguous', () => {
		const c = clock();
		const r = resolveFeedClock(
			[c],
			batch([500], 'new-boot'),
			receipt('2026-10-04T15:00:02Z'),
			null,
			'new'
		);
		expect(r).toMatchObject({ reason: 'overlapping_round_clock', clock: { anchorAt: null } });
	});
	test('a direct game packet spaces kills by eventTime rather than giving all of them now', () => {
		const r = feedReceipt(undefined, 'warcon', {}, NOW);
		const c = resolveFeedClock([], batch([100, 400, 700]), r, null, 'direct').clock!;
		expect([100, 400, 700].map((t) => stampFeedKill(r, c, t).ts.getTime())).toEqual([
			NOW.getTime() - 600_000,
			NOW.getTime() - 300_000,
			NOW.getTime()
		]);
	});
	test('several packets forwarded together keep a single anchor and ten-minute spacing', () => {
		const c = clock();
		const r = receipt('2026-10-04T15:10:00Z');
		const resolved = resolveFeedClock([c], batch([700]), r, null, 'unused');
		expect(resolved.clock?.id).toBe(c.id);
		expect(resolved.clock?.anchorAt).toEqual(c.anchorAt);
		expect(
			stampFeedKill(r, resolved.clock, 700).ts.getTime() -
				stampFeedKill(receipt('2026-10-04T15:00:00Z'), c, 100).ts.getTime()
		).toBe(600_000);
		expect(stampFeedKill(r, resolved.clock, 700)).toMatchObject({
			historical: true,
			moderationEligible: false
		});
	});
	test('an older source packet arriving later maps to the same round, without moving its watermark backwards', () => {
		const c = clock('2026-10-04T15:10:00Z', 700);
		const r = receipt('2026-10-04T15:00:00Z');
		const resolved = resolveFeedClock([c], batch([100]), r, null, 'unused');
		expect(resolved.clock?.lastReceiptAt).toEqual(c.lastReceiptAt);
		expect(stampFeedKill(r, resolved.clock, 100).eventAt?.toISOString()).toBe(
			'2026-10-04T15:00:00.000Z'
		);
	});
	test('a new server boot creates an independent clock even if matchId and map did not change', () => {
		const c = clock();
		const resolved = resolveFeedClock(
			[c],
			batch([5], 'new-boot'),
			receipt('2026-10-04T15:10:00Z'),
			null,
			'new'
		);
		expect(resolved).toMatchObject({ create: true, close: c.id, clock: { id: 'new' } });
	});
	test('a map change is a round boundary although the feed matchId stays constant', () => {
		const c = clock();
		const resolved = resolveFeedClock(
			[c],
			batch([4], 'boot', ['Toscana']),
			receipt('2026-10-04T15:10:00Z'),
			null,
			'new'
		);
		expect(resolved).toMatchObject({
			create: true,
			close: c.id,
			reason: null,
			clock: { id: 'new' }
		});
	});
	test('a same-map reset is uncertain until an independently observed new round', () => {
		const old = clock('2026-10-04T15:00:00Z', 100, 1);
		const r = receipt('2026-10-04T15:01:00Z');
		const reset = resolveFeedClock([old], batch([2]), r, 1, 'uncertain');
		expect(reset).toMatchObject({ reason: 'unobserved_reset', clock: { anchorAt: null } });
		expect(stampFeedKill(r, reset.clock, 2)).toMatchObject({
			eventAt: null,
			timeQuality: 'ambiguous',
			moderationEligible: false
		});
		const closed = { ...old, endedAt: r.packetReceivedAt };
		expect(
			resolveFeedClock(
				[closed, reset.clock!],
				batch([3]),
				receipt('2026-10-04T15:01:01Z'),
				1,
				'unused'
			).reason
		).toBe('unobserved_reset');
		expect(
			resolveFeedClock(
				[closed, reset.clock!],
				batch([4]),
				receipt('2026-10-04T15:01:02Z'),
				2,
				'known'
			).clock?.anchorAt
		).not.toBeNull();
	});
	test('mixed/reset packets get no invented event times', () => {
		for (const b of [batch([100, 2]), batch([100, 101], 'boot', ['Kavkazi', 'Toscana'])]) {
			const r = receipt('2026-10-04T15:00:00Z');
			const resolved = resolveFeedClock([], b, r, null, 'unused');
			expect(resolved.reason).toBe('mixed_round_packet');
			expect(stampFeedKill(r, resolved.clock, b.kills[0].eventTime).eventAt).toBeNull();
		}
	});
	test('clock jumps/buffering are ambiguous rather than forcing a new per-packet anchor', () => {
		const c = clock();
		expect(
			resolveFeedClock([c], batch([900]), receipt('2026-10-04T15:00:02Z'), null, 'unused')
		).toMatchObject({ clock: null, reason: 'inconsistent_clock' });
	});
	test('an old round is still resolvable after a new map, but cannot be moderated', () => {
		const c = { ...clock(), endedAt: new Date('2026-10-04T15:10:00Z') };
		const next = resolveFeedClock(
			[c],
			batch([3], 'boot', ['Toscana']),
			receipt('2026-10-04T15:10:01Z'),
			null,
			'new'
		).clock!;
		const r = receipt('2026-10-04T15:00:02Z');
		const resolved = resolveFeedClock([c, next], batch([102]), r, null, 'unused');
		expect(resolved.clock?.id).toBe(c.id);
		expect(stampFeedKill(r, resolved.clock, 102).moderationEligible).toBe(false);
	});
	test('separate delayed packets cannot produce a false speed-kill verdict', () => {
		const c = clock();
		const cfg: KillRateConfig = {
			windowMinutes: 5,
			maxKills: 3,
			headshotPct: 0,
			headshotMinKills: 15,
			cooldownMinutes: 30
		};
		const kills = [100, 700, 1300].map((eventTime) => ({
			at: stampFeedKill(receipt('2026-10-04T15:20:00Z'), c, eventTime).ts.getTime(),
			clockId: c.id,
			steamId: 'a',
			name: 'a',
			headshot: false
		}));
		expect(killRateReplay(cfg, kills)).toEqual([]);
	});
});
