import { describe, expect, test } from 'bun:test';
import {
	emptyTwoTeamsState,
	TWO_TEAMS_ASK_WINDOW_MS,
	TWO_TEAMS_CHECK_MS,
	TWO_TEAMS_FORGET_MS,
	TWO_TEAMS_MAX_ASKS,
	TWO_TEAMS_RETRY_MS,
	TWO_TEAMS_SETTLED_MS,
	teamName,
	twoTeamsSettingsKey,
	twoTeamsStep,
	validateTwoTeams,
	type TwoTeamsConfig,
	type TwoTeamsState
} from './two-teams';

const cfg: TwoTeamsConfig = {
	closedFaction: 'Lonestar',
	names: { Valkyra: 'Red', Manticore: 'Green' },
	message: 'You are on {team}.'
};
const OPEN = ['Valkyra', 'Manticore'];
const ALL = 100;
const p = (id: string, faction: string | null) => ({ steamId: id, name: `P${id}`, faction });
const first = () => 0;
const step = (
	state: TwoTeamsState,
	players: ReturnType<typeof p>[],
	now: number,
	maxMoves = ALL,
	c = cfg
) => twoTeamsStep(c, state, players, OPEN, now, maxMoves, first);

describe('validateTwoTeams', () => {
	test('needs a closed faction', () => {
		expect(() => validateTwoTeams({})).toThrow('faction');
	});
	test('keeps names for the open factions only, and an empty message', () => {
		expect(
			validateTwoTeams({
				closedFaction: 'Lonestar',
				names: { Lonestar: 'Blue', Valkyra: 'Red', Manticore: '' }
			})
		).toEqual({ closedFaction: 'Lonestar', names: { Valkyra: 'Red' }, message: '' });
	});
});

describe('twoTeamsStep', () => {
	test('moves everyone on the closed faction, filling the smaller side first', () => {
		const players = [
			p('1', 'Valkyra'),
			p('2', 'Valkyra'),
			p('3', 'Lonestar'),
			p('4', 'Lonestar'),
			p('5', 'Lonestar')
		];
		const r = step(emptyTwoTeamsState(), players, 0);
		expect(r.moves.map((m) => m.to)).toEqual(['Manticore', 'Manticore', 'Valkyra']);
	});

	test('does nothing with fewer than two open factions', () => {
		const r = twoTeamsStep(cfg, emptyTwoTeamsState(), [p('1', 'Lonestar')], ['Valkyra'], 0, ALL);
		expect(r.moves).toEqual([]);
	});

	test('leaves unplaced players and the open sides alone', () => {
		const r = step(
			emptyTwoTeamsState(),
			[p('1', null), p('2', 'Valkyra'), p('3', 'Valkyra'), p('4', 'Valkyra')],
			0
		);
		expect(r.moves).toEqual([]);
	});

	test('a move in flight is not asked for again, and counts toward its side', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar'), p('2', 'Lonestar')], 0, 1);
		expect(a.moves).toHaveLength(1);
		const to = a.moves[0].to;
		const b = step(a.state, [p('1', 'Lonestar'), p('2', 'Lonestar')], 5000);
		expect(b.moves).toEqual([expect.objectContaining({ steamId: '2' })]);
		expect(b.moves[0].to).not.toBe(to);
	});

	test('a move that has not landed is retried', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		expect(step(a.state, [p('1', 'Lonestar')], 14_999).moves).toEqual([]);
		const b = step(a.state, [p('1', 'Lonestar')], TWO_TEAMS_RETRY_MS);
		expect(b.moves).toHaveLength(1);
	});

	test('sweeps every 30 seconds while known players retry after 15 seconds', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		const players = [p('1', 'Lonestar'), p('2', 'Lonestar')];
		const early = step(a.state, players, 5000);
		expect(early.moves).toEqual([]);
		const retry = step(early.state, players, 15_000);
		expect(retry.moves.map((m) => m.steamId)).toEqual(['1']);
		const before = step(retry.state, players, 29_999);
		expect(before.moves).toEqual([]);
		const sweep = step(before.state, players, TWO_TEAMS_CHECK_MS);
		expect(sweep.moves.map((m) => m.steamId)).toEqual(['2', '1']);
	});

	test('new placements get a turn before an overdue retry', () => {
		const players = [p('1', 'Lonestar'), p('2', 'Lonestar')];
		const a = step(emptyTwoTeamsState(), players, 0, 1);
		const b = step(a.state, players, TWO_TEAMS_RETRY_MS, 1);
		expect(b.moves.map((m) => m.steamId)).toEqual(['2']);
	});

	test('a landed player is whispered once, and not again after the next match re-sort', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		const b = step(a.state, [p('1', a.moves[0].to)], 5000);
		expect(b.whispers).toEqual([{ steamId: '1', name: 'P1', faction: a.moves[0].to }]);
		const c = step(b.state, [p('1', 'Lonestar')], 60_000);
		const d = step(c.state, [p('1', c.moves[0].to)], 65_000);
		expect(d.whispers).toEqual([]);
	});

	test('no whisper and nothing remembered without a message, and none for players it never moved', () => {
		const quiet = { ...cfg, message: '' };
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0, ALL, quiet);
		const b = step(a.state, [p('1', 'Valkyra')], 5000, ALL, quiet);
		expect(b.whispers).toEqual([]);
		expect(b.state.told.size).toBe(0);
		expect(step(emptyTwoTeamsState(), [p('2', 'Valkyra')], 0).whispers).toEqual([]);
	});

	test('a told player is forgotten after long enough away', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		const b = step(a.state, [p('1', 'Valkyra')], 1000);
		expect(b.state.told.has('1')).toBe(true);
		const gone = step(b.state, [], 1000 + TWO_TEAMS_FORGET_MS + 1);
		expect(gone.state.told.size).toBe(0);
	});

	test('asks for at most the given number of moves per look; the rest go at the next looks', () => {
		const everyone = Array.from({ length: 10 }, (_, i) => p(String(i), 'Lonestar'));
		const a = step(emptyTwoTeamsState(), everyone, 0, 4);
		expect(a.moves.map((m) => m.steamId)).toEqual(['0', '1', '2', '3']);
		// the four asked are still on their way; the next four are placed against them
		const b = step(a.state, everyone, 1000, 4);
		expect(b.moves.map((m) => m.steamId)).toEqual(['4', '5', '6', '7']);
		const sides = [...a.moves, ...b.moves].map((m) => m.to);
		expect(sides.filter((s) => s === 'Valkyra')).toHaveLength(4);
	});

	test('a stuck player gets ten attempts, 15 seconds apart, then one warning and a pause', () => {
		let state = emptyTwoTeamsState();
		let asks = 0;
		const stopped: string[] = [];
		for (let look = 0; look < 12; look++) {
			const r = step(state, [p('1', 'Lonestar')], look * TWO_TEAMS_RETRY_MS);
			state = r.state;
			asks += r.moves.length;
			stopped.push(...r.stopped.map((s) => s.steamId));
		}
		expect(asks).toBe(TWO_TEAMS_MAX_ASKS);
		expect(stopped).toEqual(['1']);
		// once the window has passed, the rule tries again
		const later = step(state, [p('1', 'Lonestar')], TWO_TEAMS_ASK_WINDOW_MS + 60_000);
		expect(later.moves).toHaveLength(1);
		expect(later.state.capped.has('1')).toBe(false);
	});

	test('30 seconds settled on an open side resets the failed attempts, even without a whisper', () => {
		const quiet = { ...cfg, message: '' };
		let state = emptyTwoTeamsState();
		for (let n = 0; n <= TWO_TEAMS_MAX_ASKS; n++)
			state = step(state, [p('1', 'Lonestar')], n * TWO_TEAMS_RETRY_MS, ALL, quiet).state;
		expect(state.capped.has('1')).toBe(true);
		const at = (TWO_TEAMS_MAX_ASKS + 1) * TWO_TEAMS_RETRY_MS;
		const landed = step(state, [p('1', 'Valkyra')], at, ALL, quiet);
		expect(landed.state.asked.get('1')).toHaveLength(10);
		const settled = step(landed.state, [p('1', 'Valkyra')], at + TWO_TEAMS_SETTLED_MS, ALL, quiet);
		expect(settled.state.asked.has('1')).toBe(false);
		expect(settled.state.capped.has('1')).toBe(false);
		const returned = step(
			settled.state,
			[p('1', 'Lonestar')],
			at + TWO_TEAMS_SETTLED_MS + TWO_TEAMS_CHECK_MS,
			ALL,
			quiet
		);
		expect(returned.moves).toHaveLength(1);
	});

	test('brief switches do not reset the loop guard or allow faster moves', () => {
		let state = emptyTwoTeamsState();
		let asks = 0;
		for (let n = 0; n <= TWO_TEAMS_MAX_ASKS; n++) {
			const at = n * TWO_TEAMS_CHECK_MS;
			const blue = step(state, [p('1', 'Lonestar')], at);
			asks += blue.moves.length;
			state = step(blue.state, [p('1', 'Valkyra')], at + 1000).state;
			const returned = step(state, [p('1', 'Lonestar')], at + 2000);
			expect(returned.moves).toEqual([]);
			state = returned.state;
		}
		expect(asks).toBe(10);
		expect(state.capped.has('1')).toBe(true);
	});
});

test('teamName falls back to the faction, never to an inherited property', () => {
	expect(teamName(cfg, 'Valkyra')).toBe('Red');
	expect(teamName({ ...cfg, names: {} }, 'Valkyra')).toBe('Valkyra');
	expect(teamName(cfg, 'constructor')).toBe('constructor');
});

test("a rule's settings fingerprint does not depend on key order, and changes with any setting", () => {
	const key = twoTeamsSettingsKey(cfg);
	expect(
		twoTeamsSettingsKey({
			message: cfg.message,
			names: { ...cfg.names },
			closedFaction: 'Lonestar'
		})
	).toBe(key);
	expect(twoTeamsSettingsKey({ ...cfg, names: { Manticore: 'Green', Valkyra: 'Red' } })).toBe(key);
	expect(twoTeamsSettingsKey({ ...cfg, closedFaction: 'Valkyra' })).not.toBe(key);
	expect(twoTeamsSettingsKey({ ...cfg, message: '' })).not.toBe(key);
});
