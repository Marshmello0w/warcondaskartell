import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, and } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, listEntries, organizations } from '$lib/server/db/schema';
import { getServer, serverAccessFor } from '$lib/server/access';
import { dossier } from '$lib/server/players';
import { listOf } from '$lib/server/lists';
import { DEFAULT_BAN_REASON_PRESETS } from '$lib/ban-reasons';
import { PATCH } from '../routes/api/orgs/[id]/+server';
import { GET as orgLists } from '../routes/api/orgs/[id]/lists/+server';
import { GET as serverLists } from '../routes/api/servers/[id]/lists/state/+server';
import type { OrgListsView, ServerListsState } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { PRINCIPALS, seedWorld, type PrincipalName, type World } from './world';

const PLAYER = '76561198000000091';
const CUSTOM = ['Spawn camping', 'Ignoring admin instructions'];

describe.skipIf(!hasTestDb)('Organisation ban reason presets', () => {
	let env: Env;
	let w: World;
	const patch = (who: PrincipalName, banReasonPresets: unknown, orgId = w.org.id) =>
		callApi(PATCH, w.users[who], {
			method: 'PATCH',
			params: { id: orgId },
			body: { banReasonPresets }
		});
	const stored = async (id = w.org.id) =>
		(await env.db.select().from(organizations).where(eq(organizations.id, id)))[0].banReasonPresets;
	const orgSuggestions = async (who: PrincipalName, id = w.org.id) =>
		((await callApi(orgLists, w.users[who], { params: { id } })).body as OrgListsView)
			.banReasonPresets;
	const serverSuggestions = async (who: PrincipalName, id = w.server.id) =>
		((await callApi(serverLists, w.users[who], { params: { id } })).body as ServerListsState)
			.banReasonPresets;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
	});
	beforeEach(async () => {
		w = await seedWorld(env);
		stubGateway();
	});

	test('defaults are a JSON array; only an org owner or site owner can change them', async () => {
		expect(await stored()).toEqual(DEFAULT_BAN_REASON_PRESETS);
		for (const who of PRINCIPALS.filter((who) => who !== 'owner' && who !== 'site')) {
			expect({ who, refused: (await patch(who, CUSTOM)).status >= 400 }).toEqual({
				who,
				refused: true
			});
			expect(await stored()).toEqual(DEFAULT_BAN_REASON_PRESETS);
		}
		expect((await patch('owner', CUSTOM)).status).toBe(200);
		expect(await stored()).toEqual(CUSTOM);
		expect((await patch('site', ['Other reason'])).status).toBe(200);
		expect(await stored()).toEqual(['Other reason']);
		const [shape] =
			await env.sql`SELECT jsonb_typeof(ban_reason_presets) AS kind FROM organizations WHERE id = ${w.org.id}`;
		expect(shape.kind).toBe('array');
	});

	test('the saved ordered selection reaches org lists, both servers and the player dossier', async () => {
		const answer = await patch('owner', ['  Spawn\n camping  ', CUSTOM[1]]);
		expect(answer.body).toMatchObject({ ok: true, banReasonPresets: CUSTOM });
		for (const who of ['owner', 'admin', 'orgBans', 'keyAll', 'keyBans'] as PrincipalName[]) {
			expect(await orgSuggestions(who)).toEqual(CUSTOM);
			expect(await serverSuggestions(who)).toEqual(CUSTOM);
		}
		expect(await serverSuggestions('owner', w.otherServer.id)).toEqual(CUSTOM);
		const server = (await getServer(env, w.server.id))!;
		const owner = w.users.owner!;
		const access = (await serverAccessFor(env, owner, server.id))!;
		expect((await dossier(env, owner, server, access, PLAYER)).orgLists.banReasonPresets).toEqual(
			CUSTOM
		);
		const viewer = w.users.viewer!;
		expect(
			(await dossier(env, viewer, server, (await serverAccessFor(env, viewer, server.id))!, PLAYER))
				.orgLists.banReasonPresets
		).toBeNull();
	});

	test('suggestions stay inside their org and are withheld from readers who cannot ban', async () => {
		await patch('owner', CUSTOM);
		expect(await orgSuggestions('outsider', w.otherOrg.id)).toEqual(DEFAULT_BAN_REASON_PRESETS);
		expect(await serverSuggestions('outsider', w.otherOrgServer.id)).toEqual(
			DEFAULT_BAN_REASON_PRESETS
		);
		expect((await patch('owner', CUSTOM, w.otherOrg.id)).status).toBe(404);
		for (const who of ['viewer', 'orgSlots', 'keyView'] as PrincipalName[])
			expect(await serverSuggestions(who)).toBeNull();
		expect(await orgSuggestions('orgSlots')).toBeNull();
	});

	test('removing every suggestion persists an empty list, and defaults can be restored', async () => {
		expect((await patch('owner', [])).status).toBe(200);
		expect(await stored()).toEqual([]);
		expect(await orgSuggestions('owner')).toEqual([]);
		expect(await serverSuggestions('owner', w.otherServer.id)).toEqual([]);
		expect((await patch('owner', DEFAULT_BAN_REASON_PRESETS)).status).toBe(200);
		expect(await stored()).toEqual(DEFAULT_BAN_REASON_PRESETS);
	});

	test('invalid requests do not change the stored selection', async () => {
		await patch('owner', CUSTOM);
		for (const value of [
			null,
			'not an array',
			[''],
			['Cheating', ' CHEATING '],
			[false],
			['x'.repeat(201)],
			['null\u0000byte'],
			Array.from({ length: 31 }, (_, i) => `Reason ${i}`)
		]) {
			expect(await patch('owner', value)).toMatchObject({ status: 400, code: 'invalid_presets' });
			expect(await stored()).toEqual(CUSTOM);
		}
	});

	test('editing suggestions is audited and leaves existing bans and the ban message unchanged', async () => {
		const list = await listOf(env, w.org.id, 'ban');
		await env.db.insert(listEntries).values({
			id: `ban-${w.org.id}`,
			listId: list.id,
			steamId: PLAYER,
			reason: 'Cheating',
			addedByName: 'Moderator',
			expiresAt: new Date('2099-10-07T12:00:00Z')
		});
		const before = await env.db.select().from(listEntries).where(eq(listEntries.listId, list.id));
		const gateway = stubGateway();
		await patch('owner', CUSTOM);
		expect(await env.db.select().from(listEntries).where(eq(listEntries.listId, list.id))).toEqual(
			before
		);
		expect(
			(await env.db.select().from(organizations).where(eq(organizations.id, w.org.id)))[0]
				.banMessage
		).toBe('{reason}');
		expect(gateway.runs).toEqual([]);
		const [audit] = await env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'list.ban_reason_presets')));
		expect(audit.detail).toMatchObject({ orgId: w.org.id, banReasonPresets: CUSTOM });
	});
});
