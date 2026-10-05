import { afterEach, describe, expect, test } from 'bun:test';
import {
	evaluateTriggers,
	forgetRuleMemory,
	requireRuleCaps,
	twoTeamsMoveVerdict,
	twoTeamsWhisperVerdict,
	type TickContext
} from './triggers';
import { clanTeamsSettingsKey, validateClanTeams } from './clan-teams';
import { validateConfig, isTriggerKind } from './trigger-rules';
import type { TriggerRow } from './db/schema';
import type { Env } from './env';
import type { Player } from '$lib/types';

const p = (steamId: string, faction: string, name = `[ichbins] ${steamId}`): Player => ({
	steamId,
	faction,
	name,
	kills: 0,
	deaths: 0,
	cash: 0,
	ping: null
});
const rule = (watchOnly = false) =>
	({
		id: 'clan-rule',
		kind: 'clan_teams',
		name: 'Clan teams',
		enabled: true,
		config: validateClanTeams({ watchOnly }),
		state: null
	}) as unknown as TriggerRow;
const ctx = (players: Player[], at = 0) =>
	({
		server: { id: 'srv', name: 'Server' },
		status: {
			scores: ['Lonestar', 'Manticore', 'Valkyra'].map((name) => ({ name, colorHex: '', score: 0 }))
		},
		players,
		playersObserved: true,
		playersIntervalMs: 5000,
		ts: new Date(at)
	}) as unknown as TickContext;
const players = [p('a', 'Manticore'), p('b', 'Valkyra')];
const look = async (r: TriggerRow, c: TickContext, commit = true) => {
	const result = await evaluateTriggers({} as Env, c, [r]);
	if (commit) for (const f of result.afterCommit ?? []) f();
	return result;
};
const queued = (r: TriggerRow, i: Awaited<ReturnType<typeof look>>['intents'][number]) => ({
	triggerId: r.id,
	serverId: 'srv',
	steamId: i.steamId,
	params: i.params
});
afterEach(forgetRuleMemory);

describe('Clan automation through the trigger engine', () => {
	test('registration accepts clan-only settings and saving needs Move and Chat, not Kick', () => {
		expect(isTriggerKind('clan_teams')).toBe(true);
		expect(validateConfig('clan_teams', { balance: true, closedFaction: 'Lonestar' })).toEqual({
			watchOnly: false
		});
		const server = { name: 'Server' } as never;
		expect(() =>
			requireRuleCaps('clan_teams', {}, server, {
				caps: new Set(['automation.manage']),
				roleName: 'Viewer'
			} as never)
		).toThrow('Move');
		expect(() =>
			requireRuleCaps('clan_teams', {}, server, {
				caps: new Set(['players.move', 'chat.send']),
				roleName: 'Mover'
			} as never)
		).not.toThrow();
		expect(() =>
			requireRuleCaps('clan_teams', {}, server, {
				caps: new Set(['players.move']),
				roleName: 'Mover'
			} as never)
		).toThrow('Chat');
	});
	test('only a clan move is emitted and its delivery waits for the observation commit', async () => {
		const r = rule();
		const result = await look(r, ctx(players), false);
		expect(result.intents.map((i) => [i.action, i.target])).toEqual([['changeTeam', 'b']]);
		const i = result.intents[0];
		expect(i.params).toMatchObject({
			from: 'Valkyra',
			faction: 'Manticore',
			rule: clanTeamsSettingsKey(r.config as never)
		});
		expect(twoTeamsMoveVerdict(queued(r, i))).toBe('wait');
		for (const f of result.afterCommit ?? []) f();
		expect(twoTeamsMoveVerdict(queued(r, i))).toBe('send');
	});
	test('failed transaction is retried; committed retries wait 15s and invalidate old rows', async () => {
		const r = rule();
		await look(r, ctx(players), false);
		const first = await look(r, ctx(players, 1000));
		expect(first.intents).toHaveLength(1);
		expect((await look(r, ctx(players, 15_999))).intents).toEqual([]);
		const second = await look(r, ctx(players, 16_000));
		expect(second.intents).toHaveLength(1);
		expect(twoTeamsMoveVerdict(queued(r, first.intents[0]))).toBe('No longer wanted by the rule.');
	});
	test('renames, landings and match boundaries cancel queued clan moves', async () => {
		for (const change of ['rename', 'land', 'match']) {
			forgetRuleMemory();
			const r = rule();
			const first = await look(r, ctx(players));
			const next =
				change === 'rename'
					? ctx([players[0], p('b', 'Valkyra', 'Solo')], 1000)
					: change === 'land'
						? ctx([players[0], p('b', 'Manticore')], 1000)
						: ({ ...ctx(players, 1000), playersObserved: false, matchEnd: {} } as TickContext);
			await look(r, next);
			expect(twoTeamsMoveVerdict(queued(r, first.intents[0]))).not.toBe('send');
		}
	});
	test('watch-only emits skipped-action instructions, with no whispers or repeated records', async () => {
		const r = rule(true);
		const first = await look(r, ctx(players));
		expect(first.intents).toHaveLength(1);
		expect(first.intents[0].watchOnly).toContain('Watch only: would move');
		expect((await look(r, ctx(players, 5000))).intents).toEqual([]);
		expect(
			(await look(r, ctx([p('a', 'Manticore'), p('b', 'Manticore')], 10_000))).intents
		).toEqual([]);
	});
	test('confirmed placements whisper the correct team and tag to both players, after commit only', async () => {
		const r = rule();
		await look(r, ctx([p('a', 'Lonestar', '[xy] First')]));
		await look(
			r,
			ctx([p('b', 'Valkyra', '[xy] Follower'), p('a', 'Lonestar', '[xy] First')], 5000)
		);
		const together = [p('b', 'Lonestar', '[xy] Follower'), p('a', 'Lonestar', '[xy] First')];
		const result = await look(r, ctx(together, 10_000), false);
		expect(result.intents.map((i) => [i.action, i.target])).toEqual([
			['whisper', 'b'],
			['whisper', 'a']
		]);
		expect(result.intents[0].params).toMatchObject({
			message: 'You were moved to Lonestar to join your clan [xy].',
			clanPlacement: { steamId: 'b', tag: 'xy', faction: 'Lonestar' }
		});
		expect(result.intents[1].params).toMatchObject({
			message:
				'[xy] Follower was moved to your team (Lonestar) because you share the clan tag [xy].'
		});
		expect(twoTeamsWhisperVerdict(queued(r, result.intents[0]))).toBe('wait');
		// A failed write did not consume the notices.
		const retry = await look(r, ctx(together, 11_000));
		expect(retry.intents).toHaveLength(2);
		expect(twoTeamsWhisperVerdict(queued(r, retry.intents[0]))).toBe('send');
		expect((await look(r, ctx(together, 15_000))).intents).toEqual([]);
		await look(r, {
			...ctx(together, 16_000),
			playersObserved: false,
			matchEnd: {}
		} as TickContext);
		expect(twoTeamsWhisperVerdict(queued(r, retry.intents[0]))).toBe('A new match began.');
	});
	test('several arrivals generate distinct notices to the same first member', async () => {
		const r = rule();
		await look(r, ctx([p('a', 'Manticore'), p('b', 'Valkyra'), p('c', 'Lonestar')]));
		const result = await look(
			r,
			ctx([p('a', 'Manticore'), p('b', 'Manticore'), p('c', 'Manticore')], 5000)
		);
		expect(result.intents).toHaveLength(4);
		expect(result.intents.filter((i) => i.target === 'a')).toHaveLength(2);
		expect(new Set(result.intents.map((i) => i.dedupeKey)).size).toBe(4);
	});
	test('untrusted name text is literal and messages stay within the game limit', async () => {
		const r = rule();
		await look(r, ctx(players));
		const result = await look(
			r,
			ctx(
				[p('a', 'Manticore'), p('b', 'Manticore', `[ichbins] {server}\n${'x'.repeat(500)}`)],
				5000
			)
		);
		const message = (result.intents[1].params as { message: string }).message;
		expect(message).toContain('{server}');
		expect(message).not.toContain('\n');
		expect(message.length).toBeLessThanOrEqual(256);
		expect(message).toEndWith('because you share the clan tag [ichbins].');
	});
});
