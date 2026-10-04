// Closing a session sets last_seen to left_at, the moment the player was last seen. Every read of
// "seen since" (boards, analytics, the seen lists, the seeding reward, dry runs) filters on left_at
// as well as last_seen for the open index to serve it, which is exact only while a close keeps
// the two equal: migration 0037 dropped the last_seen index on that understanding.
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { playerSessions } from '$lib/server/db/schema';
import { newPresence, persistPresence, type PresenceDiff } from '$lib/server/sessions';
import type { Player } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const none: PresenceDiff = {
	joined: [],
	left: [],
	stayed: [],
	factioned: [],
	renamed: [],
	returned: []
};

describe.skipIf(!hasTestDb)('closing a session', () => {
	test('leaves last_seen equal to left_at, dated to the last sighting', async () => {
		const env = await testEnv();
		const w = await seedWorld(env);
		const presence = newPresence();
		presence.loaded = true;
		const player: Player = {
			steamId: '76561198000000777',
			name: 'Closer',
			faction: 'Valkyra',
			kills: 1,
			deaths: 0,
			cash: 100,
			ping: 20
		};
		const joinedAt = new Date(Date.now() - 600_000);
		await persistPresence(
			env.db,
			w.server.id,
			presence,
			{ ...none, joined: [player] },
			joinedAt,
			false
		);
		const session = presence.open.get(player.steamId)!;
		session.lastSeen = joinedAt.getTime() + 300_000;
		await persistPresence(
			env.db,
			w.server.id,
			presence,
			{ ...none, left: [session] },
			new Date(),
			false
		);
		const [row] = await env.db
			.select()
			.from(playerSessions)
			.where(
				and(eq(playerSessions.serverId, w.server.id), eq(playerSessions.steamId, player.steamId))
			);
		expect(row.leftAt?.getTime()).toBe(session.lastSeen);
		expect(row.lastSeen.getTime()).toBe(row.leftAt!.getTime());
	});
});
