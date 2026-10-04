// A player's side as the kill feed sees it, end to end: the worker's look at the server writes a
// side the look it changes, not at the next heartbeat, since the web decides whether a kill was a
// team kill from the sessions table as the kill arrives. A player on no team (the game's holding
// side) is stored with none, so two of them are never taken for teammates; a holding side stored
// before that rule is put right when the sessions load after a restart; a leave keeps the last
// team. After every look the rows and the worker's memory agree, so a quiet look writes nothing.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, playerSessions, servers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer, type ServerMemory } from '$lib/server/observe';
import { LEAVE_GRACE_MS } from '$lib/server/sessions';
import { WardogsClient } from '$lib/server/rcon';
import { ingestBatch } from '$lib/server/feed';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const A = '76561198000000701';
const B = '76561198000000702';
const C = '76561198000000703';
const D = '76561198000000704';
const E = '76561198000000705';
const F = '76561198000000706';
// The mock game's scoreboard has Valkyra, Lonestar and Manticore; White is the holding side.
const on = (steamId: string, faction: string) => ({
	name: `p${steamId.slice(-3)}`,
	steamId,
	faction,
	kills: 0
});

describe.skipIf(!hasTestDb)("a player's side, from the worker's look to the kill feed", () => {
	let env: Env;
	let w: World;
	/** the worker's memory of the server; a fresh one is a worker restart */
	let fresh: () => ServerMemory;
	let m: ServerMemory;
	let list: ReturnType<typeof on>[] = [];
	let spy: ReturnType<typeof spyOn>;
	const bootStartedAt = Date.now() - 100_000;

	/** What the sessions table holds as the player's side, the web's only view of it. */
	const sideOf = async (steamId: string) =>
		(
			await env.db
				.select({ faction: playerSessions.faction })
				.from(playerSessions)
				.where(
					and(
						eq(playerSessions.serverId, w.server.id),
						eq(playerSessions.steamId, steamId),
						isNull(playerSessions.leftAt)
					)
				)
		)[0]?.faction;
	/** The side the player's last closed session was left with. */
	const leftSideOf = async (steamId: string) =>
		(
			await env.db
				.select({ faction: playerSessions.faction })
				.from(playerSessions)
				.where(
					and(
						eq(playerSessions.serverId, w.server.id),
						eq(playerSessions.steamId, steamId),
						isNotNull(playerSessions.leftAt)
					)
				)
				.orderBy(desc(playerSessions.id))
				.limit(1)
		)[0]?.faction;
	const look = async (...players: ReturnType<typeof on>[]) => {
		list = players;
		m.playersIntervalMs = 1000;
		await observeServer(env, m, { status: true, players: true });
		for (const s of m.presence.open.values()) {
			expect([s.steamId, s.writtenTeam]).toEqual([s.steamId, s.team]);
			expect([s.steamId, await sideOf(s.steamId)]).toEqual([s.steamId, s.team]);
		}
	};
	/** A kill arriving through the feed now: was it taken for a team kill? */
	const kill = async (killer: string, victim: string) => {
		const r = await ingestBatch(env, w.server.id, {
			serverId: `boot:${w.server.id}`,
			serverName: 'Test',
			events: [
				{
					eventId: randomUUID(),
					type: 'killed',
					eventTime: (Date.now() - bootStartedAt) / 1000,
					matchId: randomUUID(),
					mapName: 'Kavkazi',
					killerName: `p${killer.slice(-3)}`,
					killerSteamId: killer,
					victimName: `p${victim.slice(-3)}`,
					victimSteamId: victim,
					cause: 'Id.Item.AK74M',
					distance: 3000,
					contextTags: []
				}
			]
		});
		return r.kills[0].teamKill;
	};

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'team-kill-sides')).toBe(true);
		// The mock game answers everything but the player list, which the test scripts.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`team-kill-sides-${server.id}`
			);
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) =>
				method === 'GET' && path === '/v1/players'
					? {
							status: 200,
							statusText: 'OK',
							headers: { 'content-type': 'application/json' },
							text: JSON.stringify({ players: list })
						}
					: raw(method, path, body, headers);
			return client;
		});
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		fresh = () => {
			forgetMemory(server.id);
			return memoryFor(server, org);
		};
		m = fresh();
	});

	afterAll(async () => {
		spy.mockRestore();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});

	test('a switch is written at the next look, and the next kill is judged by it', async () => {
		await look(on(A, 'Lonestar'), on(B, 'Lonestar'));
		expect([await sideOf(A), await sideOf(B)]).toEqual(['Lonestar', 'Lonestar']);
		expect(await kill(A, B)).toBe(true);
		// The heartbeat has just run: nothing else writes these rows for the next half minute.
		m.presence.heartbeatAt = Date.now();
		await look(on(A, 'Valkyra'), on(B, 'Lonestar'));
		expect(await sideOf(A)).toBe('Valkyra');
		expect(await kill(A, B)).toBe(false);
		await look(on(A, 'Lonestar'), on(B, 'Lonestar'));
		expect(await sideOf(A)).toBe('Lonestar');
		expect(await kill(A, B)).toBe(true);
		// The holding side between matches is no side: the row keeps the last team.
		await look(on(A, 'White'), on(B, 'Lonestar'));
		expect(await sideOf(A)).toBe('Lonestar');
		// A heartbeat that is due writes the side with the rest.
		m.presence.heartbeatAt = 0;
		await look(on(A, 'Manticore'), on(B, 'Lonestar'));
		expect(await sideOf(A)).toBe('Manticore');
	});

	test("players on no team are stored with none and are nobody's teammates", async () => {
		m.presence.heartbeatAt = Date.now();
		await look(on(A, 'Lonestar'), on(B, 'Lonestar'), on(C, 'White'), on(D, 'White'));
		expect([await sideOf(C), await sideOf(D)]).toEqual([null, null]);
		expect(await kill(C, D)).toBe(false);
		// Their picks are written at once, whatever the heartbeat.
		await look(on(A, 'Lonestar'), on(B, 'Lonestar'), on(C, 'Lonestar'), on(D, 'Manticore'));
		expect([await sideOf(C), await sideOf(D)]).toEqual(['Lonestar', 'Manticore']);
		expect(await kill(C, D)).toBe(false);
		expect(await kill(C, A)).toBe(true);
	});

	test('a holding side stored before this rule is put right at the first look after a restart', async () => {
		await look(on(A, 'Lonestar'), on(B, 'Lonestar'), on(E, 'White'));
		// Rows written before only teams were kept held the holding side's name.
		await env.db
			.update(playerSessions)
			.set({ faction: 'White' })
			.where(
				and(
					eq(playerSessions.serverId, w.server.id),
					eq(playerSessions.steamId, E),
					isNull(playerSessions.leftAt)
				)
			);
		m = fresh();
		await look(on(A, 'Lonestar'), on(B, 'Lonestar'), on(E, 'White'));
		expect(await sideOf(E)).toBeNull();
	});

	test('a leave keeps the last team, and a player never on one leaves with none', async () => {
		await look(on(A, 'Lonestar'), on(B, 'Lonestar'), on(F, 'White'));
		await look(on(A, 'White'), on(B, 'Lonestar'), on(F, 'White'));
		// Both gone for longer than the leave grace.
		for (const id of [A, F]) m.presence.open.get(id)!.lastSeen = Date.now() - LEAVE_GRACE_MS - 1000;
		await look(on(B, 'Lonestar'));
		expect([await leftSideOf(A), await leftSideOf(F)]).toEqual(['Lonestar', null]);
	});
});
