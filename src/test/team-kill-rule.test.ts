// A Team kill limit rule as the worker runs it: a player's team kills count within the match they
// arrive in, so an earlier match of the same stay never adds to it, and leaving and joining again
// does not start it over. A batch counts up to itself, even when it is acted on after its match
// closed or after later batches came in; one that came in with no match open counts that server's
// such kills of the hour before. Team kills by a cause the rule leaves out (barbed wire, unless its
// list says otherwise) stay team kills but add to no count and are never acted on. The dry run
// replays the same count, and rules saved with the old default texts are moved to the new ones by
// migration 0035.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	feedClocks,
	kills,
	matches,
	outbox,
	playerSessions,
	triggers
} from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { onKillsIngested } from '$lib/server/feed-events';
import { ingestBatch } from '$lib/server/feed';
import { dryRun, invalidateTriggers } from '$lib/server/triggers';
import { newId } from '$lib/server/http';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const STAYER = { id: '76561198000000501', name: 'Stayer' };
const REJOINER = { id: '76561198000000502', name: 'Rejoiner' };
const MATE = { id: '76561198000000503', name: 'Mate' };
const LATE = { id: '76561198000000504', name: 'Late' };
const BUILDER = { id: '76561198000000505', name: 'Builder' };
const FENCER = { id: '76561198000000506', name: 'Fencer' };
const SAPPER = { id: '76561198000000507', name: 'Sapper' };
const MIXER = { id: '76561198000000508', name: 'Mixer' };
const WIRE = 'Id.Buildable.BarbedWire';
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

/** One `killed` event as the game posts it; a null cause is one the game left out. */
const eventOf = (
	killer: typeof STAYER,
	victim: typeof STAYER,
	cause: string | null = 'Id.Item.AK74M'
) => ({
	eventId: randomUUID(),
	type: 'killed',
	eventTime: 100,
	matchId: randomUUID(),
	mapName: 'Kavkazi',
	killerName: killer.name,
	killerSteamId: killer.id,
	victimName: victim.name,
	victimSteamId: victim.id,
	cause,
	distance: 3000,
	contextTags: []
});
/** One feed batch with one kill, as the game posts it. */
const batchOf = (killer: typeof STAYER, victim: typeof STAYER, cause?: string | null) => ({
	serverId: randomUUID(),
	serverName: 'Test',
	events: [eventOf(killer, victim, cause)]
});

describe.skipIf(!hasTestDb)('Team kill limit, live', () => {
	let env: Env;
	let w: World;
	/** the rule on the server under test, and one on the org's other server */
	let here: string;
	let there: string;
	let earlier = 0;
	let current = 0;
	const roundStarts = new Map<number, Date>();
	const openOrigin = ago(60 * MIN);
	const fixtureClock = (serverId: string, matchRow: number | null, at: Date) =>
		`fixture:${serverId}:${matchRow ?? (at < openOrigin ? 'old' : 'open')}`;

	/** What a rule did about a player, oldest first: the action and the count it acted on. */
	const actionsOn = async (rule: string, steamId: string) =>
		(
			await env.db
				.select()
				.from(outbox)
				.where(and(eq(outbox.triggerId, rule), eq(outbox.steamId, steamId)))
				.orderBy(asc(outbox.id))
		).map((r) => [r.action, (r.detail as { count: number }).count]);

	/** A team kill the feed delivered some time ago, on a server and in a match. */
	const pastTeamKill = (
		serverId: string,
		killer: typeof STAYER,
		matchRow: number | null,
		at: Date
	) => ({
		ts: at,
		eventAt: at,
		packetReceivedAt: at,
		warconReceivedAt: at,
		timeQuality: 'clock',
		clockId: fixtureClock(serverId, matchRow, at),
		moderationEligible: true,
		historical: false,
		serverId,
		eventId: randomUUID(),
		instanceId: 'i',
		matchId: 'm',
		matchRow,
		eventTime: 100,
		map: 'Kavkazi',
		killerSteamId: killer.id,
		killerName: killer.name,
		killerFaction: 'Lonestar',
		victimSteamId: MATE.id,
		victimName: MATE.name,
		victimFaction: 'Lonestar',
		cause: 'Id.Item.AK74M',
		teamKill: true,
		tags: []
	});

	/** A team kill coming in through the feed, stamped with whatever match is open, as the web does. */
	const receive = async (
		serverId: string,
		killer: typeof STAYER,
		now = new Date(),
		cause?: string | null
	) => {
		const [match] = await env.db
			.select()
			.from(matches)
			.where(and(eq(matches.serverId, serverId), isNull(matches.endedAt)))
			.orderBy(matches.id)
			.limit(1);
		const origin = match?.startedAt ?? openOrigin;
		const body = { ...batchOf(killer, MATE, cause), serverId: `boot:${serverId}` };
		body.events[0].mapName = match?.map ?? 'Kavkazi';
		body.events[0].eventTime = (now.getTime() - origin.getTime()) / 1000;
		const r = await ingestBatch(env, serverId, body, now);
		expect(r.kills.map((k) => k.teamKill)).toEqual([true]);
		return r.kills;
	};
	/** ...and handed to the rules at once, as the worker does. */
	const arrives = async (serverId: string, killer: typeof STAYER, cause?: string | null) =>
		onKillsIngested(env, serverId, await receive(serverId, killer, new Date(), cause));

	/** A rule as saved; without `extra` it is one saved before the list of causes not counted existed. */
	const ruleOn = async (serverId: string, extra: Record<string, unknown> = {}) => {
		const id = newId();
		await env.db.insert(triggers).values({
			id,
			serverId,
			orgId: w.org.id,
			kind: 'team_kill',
			name: 'Team kill limit',
			enabled: true,
			config: {
				warnAt: 1,
				warnMessage: 'Careful, {name}: that was a team kill ({count} this match).',
				kickAt: 3,
				kickReason: 'Team killing ({count} this match).',
				...extra
			}
		});
		return id;
	};

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'team-kill test')).toBe(true);
		here = await ruleOn(w.server.id);
		there = await ruleOn(w.otherServer.id);
		// The match before this one ended 40 minutes ago; this one is still on. The org's other
		// server has no match row yet, so its kills come in stamped with none.
		const rounds = await env.db
			.insert(matches)
			.values([
				{ serverId: w.server.id, startedAt: ago(120 * MIN), endedAt: ago(40 * MIN), map: 'Europe' },
				{ serverId: w.server.id, startedAt: ago(40 * MIN), map: 'Kavkazi' }
			])
			.returning({ id: matches.id, startedAt: matches.startedAt });
		[earlier, current] = rounds.map((r) => r.id);
		for (const r of rounds) roundStarts.set(r.id, r.startedAt);
		for (const serverId of [w.server.id, w.otherServer.id]) {
			const matchRow = serverId === w.server.id ? current : null;
			const anchorAt = matchRow ? roundStarts.get(matchRow)! : openOrigin;
			const lastReceiptAt = ago(15 * MIN);
			await env.db.insert(feedClocks).values({
				id: fixtureClock(serverId, matchRow, lastReceiptAt),
				serverId,
				instanceId: `boot:${serverId}`,
				sourceId: 'direct',
				map: 'Kavkazi',
				matchRow,
				anchorAt,
				firstReceiptAt: anchorAt,
				lastReceiptAt,
				maxEventTime: (lastReceiptAt.getTime() - anchorAt.getTime()) / 1000
			});
		}
		const session = (
			serverId: string,
			p: typeof STAYER,
			joined: number,
			left: number | null = null
		) => ({
			serverId,
			steamId: p.id,
			name: p.name,
			faction: 'Lonestar',
			joinedAt: ago(joined),
			lastSeen: ago(left ?? 0),
			leftAt: left === null ? null : ago(left)
		});
		await env.db.insert(playerSessions).values([
			// on for two hours, through both matches
			session(w.server.id, STAYER, 125 * MIN),
			// on for part of this match, gone, back five minutes ago
			session(w.server.id, REJOINER, 35 * MIN, 10 * MIN),
			session(w.server.id, REJOINER, 5 * MIN),
			session(w.server.id, MATE, 125 * MIN),
			session(w.server.id, LATE, 5 * MIN),
			session(w.server.id, BUILDER, 5 * MIN),
			session(w.server.id, FENCER, 5 * MIN),
			session(w.server.id, SAPPER, 5 * MIN),
			session(w.server.id, MIXER, 5 * MIN),
			session(w.otherServer.id, STAYER, 125 * MIN),
			session(w.otherServer.id, MATE, 125 * MIN)
		]);
		await env.db.insert(kills).values([
			// two in the match before, in the same stay
			pastTeamKill(w.server.id, STAYER, earlier, ago(90 * MIN)),
			pastTeamKill(w.server.id, STAYER, earlier, ago(60 * MIN)),
			// two in this match, before leaving
			pastTeamKill(w.server.id, REJOINER, current, ago(30 * MIN)),
			pastTeamKill(w.server.id, REJOINER, current, ago(20 * MIN)),
			// on the org's other server with no match: one over an hour ago, one within the hour
			pastTeamKill(w.otherServer.id, STAYER, null, ago(90 * MIN)),
			pastTeamKill(w.otherServer.id, STAYER, null, ago(15 * MIN)),
			// and one on another org's server, also stamped with none
			pastTeamKill(w.otherOrgServer.id, STAYER, null, ago(10 * MIN))
		]);
	});
	afterAll(() => releaseOwnership(env));

	test("an earlier match of the same stay does not count: this match's first is a whisper", async () => {
		await arrives(w.server.id, STAYER);
		expect(await actionsOn(here, STAYER.id)).toEqual([['whisper', 1]]);
		const [row] = await env.db.select().from(outbox).where(eq(outbox.triggerId, here));
		expect((row.params as { message: string }).message).toBe(
			'Careful, Stayer: that was a team kill (1 this match).'
		);
	});

	test('leaving and joining again in the same match keeps the count: the third is a kick', async () => {
		await arrives(w.server.id, REJOINER);
		expect(await actionsOn(here, REJOINER.id)).toEqual([['kick', 3]]);
		const [row] = await env.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.triggerId, here), eq(outbox.steamId, REJOINER.id)));
		expect((row.params as { reason: string }).reason).toBe('Team killing (3 this match).');
	});

	test('the dry run counts the same way, match by match', async () => {
		const server = { ...w.server, name: 'one' } as Parameters<typeof dryRun>[1];
		const r = await dryRun(env, server, 'team_kill', { warnAt: 1, kickAt: 3 });
		expect(r.items.map((i) => i.text)).toEqual([
			'whisper Stayer: Careful, Stayer: that was a team kill (1 this match).',
			'whisper Stayer: Careful, Stayer: that was a team kill (2 this match).',
			'whisper Rejoiner: Careful, Rejoiner: that was a team kill (1 this match).',
			'whisper Rejoiner: Careful, Rejoiner: that was a team kill (2 this match).',
			'whisper Stayer: Careful, Stayer: that was a team kill (1 this match).',
			`kick Rejoiner (${REJOINER.id}): Team killing (3 this match).`
		]);
	});

	test('a batch reaching the worker after its match closed cannot act; the next round starts over', async () => {
		const stamped = await receive(w.server.id, STAYER);
		// The worker sees the next match begin before it gets to the batch.
		await env.db.update(matches).set({ endedAt: new Date() }).where(eq(matches.id, current));
		await env.db
			.insert(matches)
			.values({ serverId: w.server.id, startedAt: new Date(), map: 'Europe' });
		await onKillsIngested(env, w.server.id, stamped);
		await arrives(w.server.id, STAYER);
		expect(await actionsOn(here, STAYER.id)).toEqual([
			['whisper', 1],
			['whisper', 1]
		]);
	});

	test('a batch acted on after a later one came in counts up to itself', async () => {
		const first = await receive(w.server.id, LATE);
		const second = await receive(w.server.id, LATE);
		await onKillsIngested(env, w.server.id, first);
		await onKillsIngested(env, w.server.id, second);
		expect(await actionsOn(here, LATE.id)).toEqual([
			['whisper', 1],
			['whisper', 2]
		]);
	});

	test("with no match open: this server's such kills of the hour before, never another server's", async () => {
		await arrives(w.otherServer.id, STAYER);
		expect(await actionsOn(there, STAYER.id)).toEqual([['whisper', 2]]);
		const server = { ...w.otherServer, name: 'two' } as Parameters<typeof dryRun>[1];
		const r = await dryRun(env, server, 'team_kill', { warnAt: 1, kickAt: 3 });
		expect(r.items.map((i) => i.text)).toEqual([
			'whisper Stayer: Careful, Stayer: that was a team kill (1 this match).',
			'whisper Stayer: Careful, Stayer: that was a team kill (1 this match).',
			'whisper Stayer: Careful, Stayer: that was a team kill (2 this match).'
		]);
	});

	test('a rule saved before the list: barbed wire stays a team kill but is never counted or acted on', async () => {
		await arrives(w.server.id, BUILDER, WIRE);
		await arrives(w.server.id, BUILDER, WIRE.toUpperCase());
		expect(await actionsOn(here, BUILDER.id)).toEqual([]);
		await arrives(w.server.id, BUILDER);
		expect(await actionsOn(here, BUILDER.id)).toEqual([['whisper', 1]]);
	});

	test('each rule counts by its own list: an empty one counts barbed wire', async () => {
		const all = await ruleOn(w.server.id, { notCounted: [] });
		const claymores = await ruleOn(w.server.id, { notCounted: ['Id.Item.Claymore'] });
		invalidateTriggers(w.server.id);
		await arrives(w.server.id, FENCER, WIRE);
		await arrives(w.server.id, FENCER);
		await arrives(w.server.id, FENCER, 'Id.Item.Claymore');
		expect(await actionsOn(all, FENCER.id)).toEqual([
			['whisper', 1],
			['whisper', 2],
			['kick', 3]
		]);
		expect(await actionsOn(claymores, FENCER.id)).toEqual([
			['whisper', 1],
			['whisper', 2]
		]);
		expect(await actionsOn(here, FENCER.id)).toEqual([
			['whisper', 1],
			['whisper', 2]
		]);
		// the two rules take nothing more from here on
		await env.db.update(triggers).set({ enabled: false }).where(eq(triggers.id, all));
		await env.db.update(triggers).set({ enabled: false }).where(eq(triggers.id, claymores));
		invalidateTriggers(w.server.id);
	});

	test('the dry run leaves out what the rule does not count, and says how many', async () => {
		const server = { ...w.server, name: 'one' } as Parameters<typeof dryRun>[1];
		const of = (r: Awaited<ReturnType<typeof dryRun>>, name: string) =>
			r.items
				.map((i) => i.text)
				.filter((t) => t.startsWith(`whisper ${name}:`) || t.startsWith(`kick ${name} `));
		const before = await dryRun(env, server, 'team_kill', { warnAt: 1, kickAt: 3 });
		expect(of(before, 'Builder')).toEqual([
			'whisper Builder: Careful, Builder: that was a team kill (1 this match).'
		]);
		expect(of(before, 'Fencer')).toEqual([
			'whisper Fencer: Careful, Fencer: that was a team kill (1 this match).',
			'whisper Fencer: Careful, Fencer: that was a team kill (2 this match).'
		]);
		expect(before.notes).toContain('Not counted: 3 by Barbed wire.');
		const all = await dryRun(env, server, 'team_kill', { warnAt: 1, kickAt: 3, notCounted: [] });
		expect(of(all, 'Fencer')).toEqual([
			'whisper Fencer: Careful, Fencer: that was a team kill (1 this match).',
			'whisper Fencer: Careful, Fencer: that was a team kill (2 this match).',
			`kick Fencer (${FENCER.id}): Team killing (3 this match).`
		]);
		expect(all.notes.some((n) => n.startsWith('Not counted'))).toBe(false);
		const both = await dryRun(env, server, 'team_kill', {
			warnAt: 1,
			kickAt: 3,
			notCounted: ['Id.Item.Claymore', WIRE]
		});
		expect(of(both, 'Fencer')).toEqual([
			'whisper Fencer: Careful, Fencer: that was a team kill (1 this match).'
		]);
		expect(both.notes).toContain('Not counted: 3 by Barbed wire, 1 by Claymore.');
	});

	test('a team kill with no cause is counted, live and in the dry run', async () => {
		await arrives(w.server.id, SAPPER, null);
		expect(await actionsOn(here, SAPPER.id)).toEqual([['whisper', 1]]);
		const server = { ...w.server, name: 'one' } as Parameters<typeof dryRun>[1];
		const r = await dryRun(env, server, 'team_kill', { warnAt: 1, kickAt: 3 });
		expect(r.items.map((i) => i.text).filter((t) => t.startsWith('whisper Sapper:'))).toEqual([
			'whisper Sapper: Careful, Sapper: that was a team kill (1 this match).'
		]);
	});

	test('a batch with a counted and a left-out kill by one player acts on the counted one', async () => {
		const [match] = await env.db
			.select()
			.from(matches)
			.where(and(eq(matches.serverId, w.server.id), isNull(matches.endedAt)))
			.limit(1);
		const receivedAt = new Date();
		const events = [eventOf(MIXER, MATE), eventOf(MIXER, LATE, WIRE)].map((e) => ({
			...e,
			mapName: match?.map ?? 'Kavkazi',
			eventTime: (receivedAt.getTime() - (match?.startedAt ?? openOrigin).getTime()) / 1000
		}));
		const r = await ingestBatch(
			env,
			w.server.id,
			{
				serverId: `boot:${w.server.id}`,
				serverName: 'Test',
				events
			},
			receivedAt
		);
		expect(r.kills.map((k) => k.teamKill)).toEqual([true, true]);
		await onKillsIngested(env, w.server.id, r.kills);
		const rows = await env.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.triggerId, here), eq(outbox.steamId, MIXER.id)));
		expect(rows.map((row) => row.detail)).toEqual([
			{ name: 'Mixer', victim: 'Mate', count: 1, eventId: r.kills[0].eventId }
		]);
	});

	test('migration 0035 moves the old default texts to "this match" and leaves written ones', async () => {
		const saved = (config: Record<string, unknown>) => ({
			id: newId(),
			serverId: w.otherServer.id,
			orgId: w.org.id,
			kind: 'team_kill' as const,
			name: 'Team kill limit',
			enabled: false,
			config
		});
		const defaults = saved({
			warnAt: 2,
			warnMessage: 'Careful, {name}: that was a team kill ({count} this session).',
			kickAt: 4,
			kickReason: 'Team killing ({count} this session).'
		});
		const written = saved({
			warnAt: 2,
			warnMessage: 'No team kills here, {name} ({count} this session).',
			kickAt: 4,
			kickReason: 'Team killing ({count} this session). Appeal on our site.'
		});
		await env.db.insert(triggers).values([defaults, written]);
		const text = await Bun.file('drizzle/0035_team_kill_match_texts.sql').text();
		for (const stmt of text.split('--> statement-breakpoint')) await env.db.execute(sql.raw(stmt));
		const config = async (id: string) =>
			(await env.db.select().from(triggers).where(eq(triggers.id, id)))[0].config;
		expect(await config(defaults.id)).toEqual({
			warnAt: 2,
			warnMessage: 'Careful, {name}: that was a team kill ({count} this match).',
			kickAt: 4,
			kickReason: 'Team killing ({count} this match).'
		});
		expect(await config(written.id)).toEqual(written.config);
	});
});
