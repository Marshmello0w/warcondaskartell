// What became of a rule's whisper or kick is told in the panel's own words, delivered or refused:
// the game's words are read by staff of this server (Recent actions, the audit trail, Discord) and
// might repeat the text, which can tell a player their stats across the organisation. A broadcast,
// which tells nobody anything of their own, keeps the game's answer as before.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, outbox, servers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor } from '$lib/server/observe';
import { startDelivery, stopDelivery } from '$lib/server/outbox';
import { GameError, WardogsClient } from '$lib/server/rcon';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const OWL = { steamId: '76561198000000901', name: '[ABC] Night Owl' };
const SECRET = 'across our servers: 1030 kills';

describe.skipIf(!hasTestDb)('what a rule’s whisper or kick records', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'stats-delivery')).toBe(true);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		m.players = [{ ...OWL, faction: 'Valkyra', kills: 0, deaths: 0, cash: 0, ping: 40 }];
		m.playersAt = Date.now();
		m.presence.loaded = true;
		// a game whose answers, and refusals, repeat what it was sent
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(
			async () =>
				({
					json: async (method: string, path: string, body?: Record<string, string>) => {
						const text = body?.message ?? body?.reason ?? '';
						if (text.startsWith('gone'))
							throw new GameError(404, `no player to send "${text}"`, 'player_not_found');
						if (text.startsWith('odd'))
							throw new GameError(400, `cannot send "${text}"`, 'bad_request');
						return { message: `${method} ${path}: ${text}` };
					}
				}) as unknown as WardogsClient
		);
	});

	afterAll(async () => {
		stopDelivery();
		spy.mockRestore();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});

	const queue = async (
		action: 'whisper' | 'kick' | 'broadcast',
		params: Record<string, unknown>,
		key: string
	) =>
		(
			await env.db
				.insert(outbox)
				.values({
					serverId: w.server.id,
					triggerName: 'Welcome whisper',
					triggerKind: 'welcome',
					action,
					params: action === 'broadcast' ? params : { steamId: OWL.steamId, ...params },
					target: action === 'broadcast' ? 'everyone' : OWL.steamId,
					steamId: action === 'broadcast' ? null : OWL.steamId,
					okMessage:
						action === 'kick'
							? `Kicked ${OWL.name}.`
							: action === 'whisper'
								? `Whispered ${OWL.name}.`
								: 'Broadcast sent.',
					dedupeKey: key
				})
				.returning({ id: outbox.id })
		)[0].id;
	const rowOf = async (id: number) =>
		(await env.db.select().from(outbox).where(eq(outbox.id, id)))[0];
	const until = async (ok: () => Promise<boolean>) => {
		for (let i = 0; i < 200 && !(await ok()); i++) await Bun.sleep(50);
	};

	test('the panel’s own words for a whisper or kick, sent or refused; the game’s for a broadcast', async () => {
		const ids = [
			await queue('whisper', { message: `Welcome! ${SECRET}` }, 'a'),
			await queue('kick', { reason: `Bye. ${SECRET}` }, 'b'),
			await queue('whisper', { message: `gone ${SECRET}` }, 'c'),
			await queue('kick', { reason: `odd ${SECRET}` }, 'd'),
			await queue('broadcast', { message: 'Welcome all' }, 'e')
		];
		startDelivery(env);
		await until(async () =>
			(await Promise.all(ids.map(rowOf))).every(
				(r) => r.state !== 'pending' && r.state !== 'sending'
			)
		);
		const rows = await Promise.all(ids.map(rowOf));
		expect(rows.map((r) => [r.state, r.outcome])).toEqual([
			['delivered', `Whispered ${OWL.name}.`],
			['delivered', `Kicked ${OWL.name}.`],
			['failed', 'Refused: the player is not on the server.'],
			['failed', 'Refused by the server (400, bad_request).'],
			['delivered', 'POST /v1/broadcast: Welcome all']
		]);
		// nor does the trail, which the delivery writes after the row
		await until(async () => {
			const [n] = await env.db.execute<{ n: string }>(sql`
				SELECT COUNT(*) AS n FROM audit_log WHERE server_id = ${w.server.id} AND category = 'trigger'`);
			return Number(n.n) === ids.length;
		});
		const [leaked] = await env.db.execute<{ n: string; all: string }>(sql`
			SELECT COUNT(*) FILTER (WHERE message LIKE '%1030%' OR detail::text LIKE '%1030%') AS n,
			       COUNT(*) AS all
			  FROM audit_log WHERE server_id = ${w.server.id} AND category = 'trigger'`);
		expect([Number(leaked.n), Number(leaked.all)]).toEqual([0, ids.length]);
	});
});
