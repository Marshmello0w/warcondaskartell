// The player count in the server header: the server layout reads it from the worker's last look
// after its own access check, so it reaches those who may open the server and nobody else.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import { gateway, setGateway } from '$lib/server/gateway';
import type { LiveView } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callLoad, stubGateway } from './call';
import { expected, outcomeOf } from './policy';
import { PRINCIPALS, seedWorld, type World } from './world';

const LAYOUT = join(import.meta.dir, '../routes/(app)/server/[id]/+layout.server.ts');
const SESSIONS = PRINCIPALS.filter((who) => !who.startsWith('key'));

const look = (serverId: string, ok: boolean): LiveView => ({
	serverId,
	ok,
	error: ok ? '' : 'unreachable',
	tier: 'hot',
	build: '',
	gameServerId: '',
	startedAt: null,
	reservedSlots: 4,
	throttledUntil: null,
	status: {
		serverName: 'Test',
		map: 'Zestafona',
		experiences: [],
		lighting: '',
		alternator: '',
		scoreTick: null,
		scoreTickMin: null,
		scoreTickMax: null,
		scoreCap: null,
		matchSeconds: null,
		playerCount: 42,
		maxPlayers: 100,
		scores: [],
		rotationNow: 0,
		rotationNext: 0
	},
	players: [],
	statusAt: null,
	playersAt: null,
	observedAt: new Date().toISOString()
});

describe.skipIf(!hasTestDb)('server header player count', () => {
	let env: Env;
	let world: World;
	let ok = true;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		setGateway({
			...gateway(),
			live: async (_env, ids) => new Map(ids.map((id) => [id, look(id, ok)]))
		});
		world = await seedWorld(env);
	});

	test('given to whoever may open the server, refused to the rest', async () => {
		const { load } = await import(LAYOUT);
		const got: Record<string, unknown> = {};
		const want: Record<string, unknown> = {};
		for (const who of SESSIONS) {
			const allowed = expected('cap:server.view', who);
			want[who] = allowed === 'ok' ? { players: 42, max: 100 } : allowed;
			const answer = await callLoad(load, world.users[who], { params: { id: world.server.id } });
			got[who] =
				outcomeOf(answer) === 'ok'
					? (answer.body as { occupancy: unknown }).occupancy
					: outcomeOf(answer);
		}
		expect(got).toEqual(want);
	});

	test('none while the last look failed', async () => {
		const { load } = await import(LAYOUT);
		ok = false;
		try {
			const answer = await callLoad(load, world.users.viewer, { params: { id: world.server.id } });
			expect((answer.body as { occupancy: unknown }).occupancy).toBeNull();
		} finally {
			ok = true;
		}
	});
});
