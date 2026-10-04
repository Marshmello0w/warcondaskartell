import { afterEach, describe, expect, test } from 'bun:test';
import {
	evaluateTriggers,
	forgetRuleMemory,
	requireRuleCaps,
	twoTeamsMoveVerdict,
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
	test('registration accepts clan-only settings and saving needs Move, not Chat or Kick', () => {
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
				caps: new Set(['players.move']),
				roleName: 'Mover'
			} as never)
		).not.toThrow();
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
	});
});
