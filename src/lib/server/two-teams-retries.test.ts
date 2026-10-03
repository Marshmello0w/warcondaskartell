import { describe, expect, test } from 'bun:test';
import {
	emptyTwoTeamsState,
	twoTeamsStep,
	TWO_TEAMS_CHECK_MS,
	TWO_TEAMS_MAX_ASKS,
	TWO_TEAMS_RETRY_MS,
	TWO_TEAMS_SETTLED_MS,
	type TwoTeamsConfig,
	type TwoTeamsState
} from './two-teams';

const cfg: TwoTeamsConfig = { closedFaction: 'Lonestar', names: {}, message: '' };
const open = ['Valkyra', 'Manticore'];
const player = (steamId: string, faction: string) => ({ steamId, faction, name: `P${steamId}` });
const step = (
	state: TwoTeamsState,
	players: ReturnType<typeof player>[],
	now: number,
	limit = 100,
	config = cfg
) => twoTeamsStep(config, state, players, open, now, limit, {}, () => 0);

describe('Two-team retries with upstream balancing', () => {
	test('discovers the closed faction every 30 seconds and retries known players every 15 seconds', () => {
		expect(TWO_TEAMS_RETRY_MS).toBe(15_000);
		expect(TWO_TEAMS_CHECK_MS).toBe(30_000);
		expect(TWO_TEAMS_MAX_ASKS).toBe(10);
		const first = step(emptyTwoTeamsState(), [player('1', 'Lonestar')], 0);
		const players = [player('1', 'Lonestar'), player('2', 'Lonestar')];
		const early = step(first.state, players, 14_999);
		expect(early.moves).toEqual([]);
		const retry = step(early.state, players, 15_000);
		expect(retry.moves.map((m) => m.steamId)).toEqual(['1']);
		const beforeSweep = step(retry.state, players, 29_999);
		expect(beforeSweep.moves).toEqual([]);
		const sweep = step(beforeSweep.state, players, 30_000);
		expect(sweep.moves.map((m) => m.steamId)).toEqual(['2', '1']);
	});

	test('new placements take priority over stuck retries, also while balancing', () => {
		for (const balance of [false, true]) {
			const config = { ...cfg, balance };
			const players = [player('1', 'Lonestar'), player('2', 'Lonestar')];
			const first = step(emptyTwoTeamsState(), players, 0, 1, config);
			const next = step(first.state, players, 15_000, 1, config);
			expect(next.moves.map((m) => m.steamId)).toEqual(['2']);
		}
	});

	test('a player settled on their placed side for 30 seconds gets a fresh attempt budget', () => {
		for (const balance of [false, true]) {
			const config = { ...cfg, balance };
			let state = emptyTwoTeamsState();
			for (let n = 0; n <= TWO_TEAMS_MAX_ASKS; n++)
				state = step(state, [player('1', 'Lonestar')], n * 15_000, 100, config).state;
			expect(state.capped.has('1')).toBe(true);
			const landed = step(state, [player('1', 'Valkyra')], 165_000, 100, config);
			expect(landed.state.asked.get('1')).toHaveLength(10);
			const settled = step(
				landed.state,
				[player('1', 'Valkyra')],
				165_000 + TWO_TEAMS_SETTLED_MS,
				100,
				config
			);
			expect(settled.state.asked.has('1')).toBe(false);
			expect(settled.state.capped.has('1')).toBe(false);
			expect(
				step(settled.state, [player('1', 'Lonestar')], 225_000, 100, config).moves
			).toHaveLength(1);
		}
	});

	test('brief landings do not reset the loop guard or allow faster retries', () => {
		let state = emptyTwoTeamsState();
		let asks = 0;
		for (let n = 0; n <= TWO_TEAMS_MAX_ASKS; n++) {
			const now = n * 30_000;
			const asked = step(state, [player('1', 'Lonestar')], now);
			asks += asked.moves.length;
			const landed = step(asked.state, [player('1', 'Valkyra')], now + 1000);
			const returned = step(landed.state, [player('1', 'Lonestar')], now + 2000);
			expect(returned.moves).toEqual([]);
			state = returned.state;
		}
		expect(asks).toBe(10);
		expect(state.capped.has('1')).toBe(true);
	});

	test('a refused balancing move on an open side does not appear settled and reset its budget', () => {
		const config = { ...cfg, balance: true, gap: 3 };
		const initial = [
			...Array.from({ length: 7 }, (_, i) => player(`v${i}`, 'Valkyra')),
			...Array.from({ length: 5 }, (_, i) => player(`m${i}`, 'Manticore'))
		];
		const seeded = step(emptyTwoTeamsState(), initial, 0, 100, config);
		const switched = initial.map((p) => (p.steamId === 'm0' ? { ...p, faction: 'Valkyra' } : p));
		let state = seeded.state;
		for (let n = 0; n <= TWO_TEAMS_MAX_ASKS; n++)
			state = step(state, switched, 1000 + n * 15_000, 100, config).state;
		expect(state.asked.get('m0')).toHaveLength(10);
		expect(state.capped.has('m0')).toBe(true);
		expect(state.openSince.has('m0')).toBe(false);
	});
});
