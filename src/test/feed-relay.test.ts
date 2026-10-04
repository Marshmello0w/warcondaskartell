import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	feedClocks,
	feedEvents,
	kills,
	matches,
	outbox,
	playerSessions,
	servers,
	triggers
} from '$lib/server/db/schema';
import { ingestBatch, recentKills } from '$lib/server/feed';
import { EMPTY_FILTER } from '$lib/kills';
import { onKillsIngested } from '$lib/server/feed-events';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { validateConfig } from '$lib/server/triggers';
import { loadAnalytics } from '$lib/server/analytics';
import { POST } from '../routes/api/ingest/events/+server';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';
import { stubGateway } from './call';

const A = '76561198000000001';
const B = '76561198000000002';
const TOKEN = 'R'.repeat(43);
const FEED_TOKEN = 'wkf_' + 'F'.repeat(43);
const config = (env: Env, serverId: string): Env => ({
	...env,
	FEED_RELAY_SOURCES: JSON.stringify([{ id: 'bot', serverId, token: TOKEN }])
});
const packet = (times: number[], at?: Date, map = 'Kavkazi', instance = 'boot') => ({
	serverId: instance,
	serverName: 'Test',
	...(at ? { sourceReceivedAt: at.toISOString() } : {}),
	events: times.map((eventTime) => ({
		eventId: randomUUID(),
		type: 'killed',
		eventTime,
		matchId: 'same-across-rounds',
		mapName: map,
		killerSteamId: A,
		killerName: 'Alpha',
		victimSteamId: B,
		victimName: 'Bravo',
		cause: 'Id.Item.AK74M',
		distance: 400_000,
		contextTags: ['Meta.Progression.Context.Player.KillContext.Headshot']
	}))
});

describe.skipIf(!hasTestDb)('forwarded feed, persisted times and moderation', () => {
	let env: Env;
	beforeAll(async () => {
		env = await testEnv();
	});

	test('direct packets have separate receipts and clock-derived timestamps', async () => {
		const w = await seedWorld(env),
			now = new Date();
		const r = await ingestBatch(env, w.server.id, packet([100, 101]), now);
		expect(r.receipt).toMatchObject({
			packetReceivedAt: now.toISOString(),
			warconReceivedAt: now.toISOString(),
			sourceReceivedAt: null
		});
		expect(r.kills.map((k) => Date.parse(k.ts))).toEqual([now.getTime() - 1000, now.getTime()]);
		expect(r.kills.every((k) => k.timeQuality === 'clock' && k.moderationEligible)).toBe(true);
	});

	test('a delayed relay packet retains source and actual receipts in the database', async () => {
		const w = await seedWorld(env),
			now = new Date(),
			original = new Date(now.getTime() - 600_000);
		const r = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([100, 120], original),
			now,
			TOKEN
		);
		const rows = await env.db
			.select()
			.from(kills)
			.where(eq(kills.serverId, w.server.id))
			.orderBy(kills.eventTime);
		expect(rows.map((k) => k.ts.getTime())).toEqual([
			original.getTime() - 20_000,
			original.getTime()
		]);
		expect(
			rows.every(
				(k) =>
					k.packetReceivedAt?.getTime() === original.getTime() &&
					k.warconReceivedAt?.getTime() === now.getTime() &&
					k.sourceReceivedAt === original.toISOString()
			)
		).toBe(true);
		expect(r.timing).toMatchObject({ clock: 2, historical: 2, moderationEligible: 0 });
		expect(rows.every((k) => k.killerFaction === null && k.victimFaction === null)).toBe(true);
	});

	test('queued packets keep spacing and a database anchor across fresh Env objects', async () => {
		const w = await seedWorld(env),
			now = new Date(),
			firstAt = new Date(now.getTime() - 1200_000),
			nextAt = new Date(now.getTime() - 600_000);
		const first = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([100], firstAt),
			now,
			TOKEN
		);
		const next = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([700], nextAt),
			now,
			TOKEN
		);
		expect(next.kills[0].clockId).toBe(first.kills[0].clockId);
		expect(Date.parse(next.kills[0].ts) - Date.parse(first.kills[0].ts)).toBe(600_000);
		expect(
			await env.db.select().from(feedClocks).where(eq(feedClocks.serverId, w.server.id))
		).toHaveLength(1);
	});

	test('out-of-order originals resolve before the first seen packet without changing newer state', async () => {
		const w = await seedWorld(env),
			now = new Date(),
			late = new Date(now.getTime() - 600_000),
			early = new Date(now.getTime() - 1200_000);
		const newer = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([700], late),
			now,
			TOKEN
		);
		const older = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([100], early),
			now,
			TOKEN
		);
		expect(older.kills[0].clockId).toBe(newer.kills[0].clockId);
		expect(older.kills[0].eventAt).toBe(early.toISOString());
		const [c] = await env.db.select().from(feedClocks).where(eq(feedClocks.serverId, w.server.id));
		expect(c.lastReceiptAt).toEqual(late);
	});

	test('duplicate IDs remain unique after days, on retries, within packets and per server', async () => {
		const w = await seedWorld(env),
			now = new Date(),
			body = packet([100], now);
		body.events.push(body.events[0]);
		const first = await ingestBatch(config(env, w.server.id), w.server.id, body, now, TOKEN);
		const retry = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			body,
			new Date(now.getTime() + 3 * 86400_000),
			TOKEN
		);
		const other = await ingestBatch(
			config(env, w.otherServer.id),
			w.otherServer.id,
			body,
			now,
			TOKEN
		);
		expect([
			first.accepted,
			first.duplicates,
			retry.accepted,
			retry.duplicates,
			other.accepted
		]).toEqual([1, 1, 0, 2, 1]);
		expect(await env.db.select().from(kills).where(eq(kills.serverId, w.server.id))).toHaveLength(
			1
		);
		expect(
			await env.db.select().from(feedEvents).where(eq(feedEvents.serverId, w.server.id))
		).toHaveLength(1);
		expect(retry.timing).toMatchObject({ clock: 0, ambiguous: 0, historical: 0 });
	});

	test('same-map reset stays ambiguous until an observed round; a boot also resets the clock', async () => {
		const w = await seedWorld(env),
			now = new Date(),
			origin = new Date(now.getTime() - 60_000);
		await ingestBatch(config(env, w.server.id), w.server.id, packet([100], origin), now, TOKEN);
		const resetAt = new Date(origin.getTime() + 10_000);
		const reset = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([2], resetAt),
			now,
			TOKEN
		);
		expect(reset.kills[0]).toMatchObject({
			eventAt: null,
			timeQuality: 'ambiguous',
			moderationEligible: false
		});
		const boot = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([1], now, 'Kavkazi', 'new-boot'),
			now,
			TOKEN
		);
		expect(boot.kills[0].clockId).not.toBe(reset.kills[0].clockId);
		expect(boot.kills[0].eventAt).toBe(now.toISOString());
	});

	test('map changes with unchanged matchId are independent; mixed packets are receipt-only', async () => {
		const w = await seedWorld(env),
			now = new Date(),
			old = new Date(now.getTime() - 60_000);
		const first = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([100], old),
			now,
			TOKEN
		);
		const next = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([2], now, 'Toscana'),
			now,
			TOKEN
		);
		expect(next.kills[0].clockId).not.toBe(first.kills[0].clockId);
		const w2 = await seedWorld(env),
			mixed = packet([100, 2], now);
		mixed.events[1].mapName = 'Toscana';
		const r = await ingestBatch(config(env, w2.server.id), w2.server.id, mixed, now, TOKEN);
		expect(r.timing).toMatchObject({
			ambiguous: 2,
			moderationEligible: 0,
			reason: 'mixed_round_packet'
		});
		expect(r.kills.every((k) => k.ts === now.toISOString() && k.eventAt === null)).toBe(true);
	});

	test('old packets are not attached to the round open at Warcon delivery', async () => {
		const w = await seedWorld(env),
			now = new Date(),
			sourceAt = new Date(now.getTime() - 600_000);
		const [old, current] = await env.db
			.insert(matches)
			.values([
				{
					serverId: w.server.id,
					startedAt: new Date(now.getTime() - 1200_000),
					endedAt: new Date(now.getTime() - 300_000),
					map: 'Kavkazi'
				},
				{ serverId: w.server.id, startedAt: new Date(now.getTime() - 300_000), map: 'Toscana' }
			])
			.returning();
		await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([100], now, 'Toscana'),
			now,
			TOKEN
		);
		const historical = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([200], sourceAt),
			now,
			TOKEN
		);
		expect(historical.kills[0].matchRow).toBe(old.id);
		expect(historical.kills[0].matchRow).not.toBe(current.id);
		expect(historical.kills[0].eventAt).toBe(sourceAt.toISOString());
		const nextAt = new Date(sourceAt.getTime() + 60_000);
		const later = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([260], nextAt),
			now,
			TOKEN
		);
		const earlierAt = new Date(sourceAt.getTime() - 10_000);
		const earlier = await ingestBatch(
			config(env, w.server.id),
			w.server.id,
			packet([190], earlierAt),
			now,
			TOKEN
		);
		expect([later.kills[0].clockId, earlier.kills[0].clockId]).toEqual([
			historical.kills[0].clockId,
			historical.kills[0].clockId
		]);
		expect(later.kills[0].eventAt).toBe(nextAt.toISOString());
		expect(earlier.kills[0].eventAt).toBe(earlierAt.toISOString());
	});

	test('pagination loses no distinct IDs when clock-derived timestamps and eventTime tie', async () => {
		const w = await seedWorld(env),
			now = new Date();
		await ingestBatch(env, w.server.id, packet([100, 100, 100, 100, 100]), now);
		const first = await recentKills(env, w.server.id, null, 2, EMPTY_FILTER);
		const last = first.at(-1)!;
		const rest = await recentKills(
			env,
			w.server.id,
			{ ts: new Date(last.ts), eventTime: last.eventTime, eventId: last.eventId },
			10,
			EMPTY_FILTER
		);
		expect(first).toHaveLength(2);
		expect(rest).toHaveLength(3);
		expect(new Set([...first, ...rest].map((k) => k.eventId)).size).toBe(5);
	});

	test('historical deliveries trigger no rules and cannot inflate subsequent live team-kill counts', async () => {
		const w = await seedWorld(env),
			relayEnv = config(env, w.server.id),
			now = new Date(),
			old = new Date(now.getTime() - 600_000);
		await env.db.insert(playerSessions).values(
			[A, B].map((steamId) => ({
				serverId: w.server.id,
				steamId,
				name: steamId,
				faction: 'Lonestar',
				joinedAt: old,
				lastSeen: now
			}))
		);
		for (const [kind, cfg] of [
			['kill_rate', { maxKills: 1 }],
			['kill_distance', { causes: ['Id.Item.AK74M'], minDistanceM: 1, count: 1, action: 'flag' }],
			['team_kill', { warnAt: 1, kickAt: 3 }]
		] as const)
			await env.db.insert(triggers).values({
				id: randomUUID(),
				serverId: w.server.id,
				orgId: w.org.id,
				kind,
				name: kind,
				enabled: true,
				config: validateConfig(kind, cfg)
			});
		expect(await acquireOrRenew(env, 'relay-time tests')).toBe(true);
		try {
			const historic = await ingestBatch(
				relayEnv,
				w.server.id,
				packet([100, 101, 102], old),
				now,
				TOKEN
			);
			// Even if a later investigation established these were team kills, timing excludes them.
			await env.db.update(kills).set({ teamKill: true }).where(eq(kills.serverId, w.server.id));
			await onKillsIngested(
				relayEnv,
				w.server.id,
				historic.kills.map((k) => ({ ...k, teamKill: true }))
			);
			expect(
				await env.db.select().from(outbox).where(eq(outbox.serverId, w.server.id))
			).toHaveLength(0);
			const live = await ingestBatch(relayEnv, w.server.id, packet([702], now), now, TOKEN);
			await onKillsIngested(relayEnv, w.server.id, live.kills);
			const rows = await env.db.select().from(outbox).where(eq(outbox.serverId, w.server.id));
			expect(rows.map((r) => r.action).sort()).toEqual([
				'kill_distance_flag',
				'kill_rate_flag',
				'whisper'
			]);
			expect((rows.find((r) => r.action === 'whisper')?.detail as { count: number }).count).toBe(1);
		} finally {
			await releaseOwnership(env);
		}
	});

	test('the worker also suppresses a fresh ingest that waited too long in its internal queue', async () => {
		const w = await seedWorld(env),
			now = new Date();
		await env.db.insert(triggers).values({
			id: randomUUID(),
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'kill_rate',
			name: 'rate',
			enabled: true,
			config: validateConfig('kill_rate', { maxKills: 1 })
		});
		const r = await ingestBatch(env, w.server.id, packet([100]), now);
		const old = new Date(now.getTime() - 60_000).toISOString();
		await onKillsIngested(
			env,
			w.server.id,
			r.kills.map((k) => ({ ...k, eventAt: old, packetReceivedAt: old }))
		);
		expect(await env.db.select().from(outbox).where(eq(outbox.serverId, w.server.id))).toHaveLength(
			0
		);
	});

	test('timed analytics use event time and leave ambiguous/legacy records in history', async () => {
		const w = await seedWorld(env),
			now = new Date(),
			original = new Date(now.getTime() - 3600_000);
		await ingestBatch(config(env, w.server.id), w.server.id, packet([100], original), now, TOKEN);
		const mixed = packet([100, 1]);
		await ingestBatch(env, w.server.id, mixed, now);
		const a = await loadAnalytics(env, w.server.id, '24h');
		expect(a.combat?.kills).toBe(1);
		expect(a.combat?.unresolvedTimes).toBe(2);
		expect(a.combat?.perBucket.every((b) => Date.parse(b.ts) < now.getTime() - 3000_000)).toBe(
			true
		);
		expect(await env.db.select().from(kills).where(eq(kills.serverId, w.server.id))).toHaveLength(
			3
		);
	});

	test('the HTTP contract confirms original receipt; invalid, future and untrusted timestamps write nothing', async () => {
		const w = await seedWorld(env),
			sharedConfig = env.FEED_RELAY_SOURCES;
		await env.db
			.update(servers)
			.set({ feedTokenHash: createHash('sha256').update(FEED_TOKEN).digest('hex') })
			.where(eq(servers.id, w.server.id));
		env.FEED_RELAY_SOURCES = config(env, w.server.id).FEED_RELAY_SOURCES;
		stubGateway();
		const call = async (body: unknown, relayToken?: string) => {
			const response = await POST({
				request: new Request('http://localhost/api/ingest/events', {
					method: 'POST',
					headers: {
						authorization: `Bearer ${FEED_TOKEN}`,
						'content-type': 'application/json',
						...(relayToken ? { 'x-warcon-relay-token': relayToken } : {})
					},
					body: JSON.stringify(body)
				})
			} as never);
			return { status: response.status, body: await response.json() };
		};
		try {
			const now = new Date(),
				valid = packet([100], new Date(now.getTime() - 600_000));
			valid.sourceReceivedAt = valid.sourceReceivedAt!.replace('Z', '091Z');
			const accepted = await call(valid, TOKEN);
			expect(accepted.status).toBe(200);
			expect(accepted.body).toMatchObject({
				ok: true,
				accepted: 1,
				duplicates: 0,
				receipt: { sourceReceivedAt: valid.sourceReceivedAt, relaySourceId: 'bot' },
				timing: { historical: 1, moderationEligible: 0 }
			});
			expect((await call(valid, TOKEN)).body).toMatchObject({ accepted: 0, duplicates: 1 });
			for (const [sourceReceivedAt, credential, status, code] of [
				['nonsense', TOKEN, 400, 'invalid_source_time'],
				[new Date(Date.now() + 60_000).toISOString(), TOKEN, 400, 'future_source_time'],
				[valid.sourceReceivedAt, undefined, 403, 'untrusted_feed_relay'],
				[valid.sourceReceivedAt, 'wrong', 403, 'untrusted_feed_relay']
			] as const) {
				const rejected = await call({ ...packet([100]), sourceReceivedAt }, credential);
				expect(rejected.status).toBe(status);
				expect(rejected.body.error.code).toBe(code);
			}
			expect(await env.db.select().from(kills).where(eq(kills.serverId, w.server.id))).toHaveLength(
				1
			);
			expect(
				await env.db.select().from(feedEvents).where(eq(feedEvents.serverId, w.server.id))
			).toHaveLength(1);
		} finally {
			env.FEED_RELAY_SOURCES = sharedConfig;
		}
	});
});

describe.skipIf(!hasTestDb)('feed migration preserves old history', () => {
	test('old timestamps are untouched, existing IDs are backfilled, later legacy writes stay deduped', async () => {
		const env = await testEnv();
		const schema = 'feed_upgrade_' + randomUUID().replaceAll('-', '');
		const migration = await Bun.file('drizzle/0037_feed_event_times.sql').text();
		await env.sql.begin(async (tx) => {
			await tx.unsafe(`CREATE SCHEMA "${schema}"`);
			await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
			await tx.unsafe(
				'CREATE TABLE kills (ts timestamptz NOT NULL, server_id text NOT NULL, event_id text NOT NULL)'
			);
			await tx`INSERT INTO kills VALUES ('2026-01-01T00:00:00Z', 'server', 'old'), ('2026-01-02T00:00:00Z', 'server', 'old')`;
			for (const statement of migration.split('--> statement-breakpoint'))
				if (statement.trim()) await tx.unsafe(statement);
			const rows =
				(await tx`SELECT ts, event_at, time_quality, moderation_eligible FROM kills ORDER BY ts`) as {
					ts: Date;
					event_at: Date | null;
					time_quality: string;
					moderation_eligible: boolean;
				}[];
			expect(rows.map((r) => new Date(r.ts).toISOString())).toEqual([
				'2026-01-01T00:00:00.000Z',
				'2026-01-02T00:00:00.000Z'
			]);
			expect(
				rows.every(
					(r) => r.event_at === null && r.time_quality === 'legacy' && !r.moderation_eligible
				)
			).toBe(true);
			expect(await tx`SELECT * FROM feed_events`).toHaveLength(1);
			await tx`INSERT INTO kills (ts, server_id, event_id) VALUES ('2026-10-04T00:00:00Z', 'server', 'new-from-old-process')`;
			expect(await tx`SELECT * FROM feed_events`).toHaveLength(2);
			await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		});
	});
});
