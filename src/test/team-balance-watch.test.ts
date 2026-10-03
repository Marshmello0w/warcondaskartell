// A watch-only Team balance rule through the worker's real observation: its rows are written as
// skipped, never sent, and announced once the look is committed, so an open Automation tab lists
// them as they come (delivery, which announces every other row, never sees them).
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, outbox, servers, triggers } from '$lib/server/db/schema';
import { subscribe, type WarconEvent } from '$lib/server/events';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import {
	forgetMemory,
	memoryFor,
	observeServer,
	OFFLINE_AFTER_FAILURES,
	type ServerMemory
} from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { forgetRuleMemory, invalidateTriggers } from '$lib/server/triggers';
import { validateTwoTeams } from '$lib/server/two-teams';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const on = (n: number, faction: string) => ({
	name: `p${n}`,
	steamId: String(76561198000000800n + BigInt(n)),
	faction,
	kills: 0
});

describe.skipIf(!hasTestDb)('a watch-only Team balance rule through the observation', () => {
	let env: Env;
	let w: World;
	let m: ServerMemory;
	let list: ReturnType<typeof on>[] = [];
	let spy: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'team-balance-watch')).toBe(true);
		// The mock game answers everything but the player list, which the test scripts.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`team-balance-watch-${server.id}`
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
		await env.db.insert(triggers).values({
			id: `watch-${w.server.id}`,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'two_teams',
			name: 'Team balance',
			enabled: true,
			config: validateTwoTeams({ closedFaction: 'Lonestar', balance: true, watchOnly: true })
		});
		invalidateTriggers(w.server.id);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		forgetMemory(server.id);
		forgetRuleMemory();
		m = memoryFor(server, org);
	});

	afterAll(async () => {
		spy.mockRestore();
		forgetMemory(w.server.id);
		forgetRuleMemory();
		await releaseOwnership(env);
	});

	const look = async (players: ReturnType<typeof on>[]) => {
		list = players;
		m.playersIntervalMs = 1000;
		await observeServer(env, m, { status: true, players: true });
	};

	test('its rows are written as skipped and announced after the commit', async () => {
		const seen: WarconEvent[] = [];
		const stop = subscribe((e) => {
			if (e.type === 'outbox' && e.serverId === w.server.id) seen.push(e);
		});
		try {
			const settled = [
				...[1, 2, 3, 4, 5].map((n) => on(n, 'Valkyra')),
				...[6, 7].map((n) => on(n, 'Manticore'))
			];
			await look(settled);
			expect(seen).toEqual([]);
			// one more on Valkyra would put it four ahead
			await look([...settled, on(8, 'Valkyra')]);
			const rows = await env.db.select().from(outbox).where(eq(outbox.serverId, w.server.id));
			expect(rows.map((r) => [r.action, r.target, r.state, r.outcome])).toEqual([
				[
					'changeTeam',
					on(8, 'Valkyra').steamId,
					'skipped',
					'Watch only: would move p8 to Manticore.'
				]
			]);
			expect(seen).toEqual([
				{ type: 'outbox', serverId: w.server.id, id: rows[0].id, state: 'skipped' }
			]);
		} finally {
			stop();
		}
	});
	test('back from being out of reach, it starts over: a switch made meanwhile is not put back', async () => {
		const rows = async () =>
			(await env.db.select().from(outbox).where(eq(outbox.serverId, w.server.id))).length;
		const settled = [
			...[11, 12, 13, 14, 15].map((n) => on(n, 'Valkyra')),
			...[16, 17, 18].map((n) => on(n, 'Manticore'))
		];
		const stacked = settled.map((p) => (p.name === 'p16' ? { ...p, faction: 'Valkyra' } : p));
		await look(settled);
		const before = await rows();
		// the server was out of reach for a while; its first look back sees the switch (6 v 2)
		m.failures = OFFLINE_AFTER_FAILURES;
		await look(stacked);
		expect(await rows()).toBe(before);
		// in reach throughout, the same switch would be put back (as a watch-only row here)
		await look(settled);
		await look(stacked);
		expect(await rows()).toBe(before + 1);
	});
});
