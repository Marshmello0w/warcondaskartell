import { describe, expect, test } from 'bun:test';
import {
	ACT_AGAIN_MS,
	countsForDistance,
	killDistanceAction,
	killDistanceBanScope,
	killDistanceReplay,
	killDistanceSettingsKey,
	killDistanceStep,
	killDistanceVerdict,
	matchKey,
	validateKillDistance,
	type DistanceTracks,
	type KillDistanceConfig
} from './kill-distance';

const DEFIB = 'Id.Item.Defibrillator.Standard';
const cfg = (c: Partial<KillDistanceConfig> = {}): KillDistanceConfig => ({
	causes: [DEFIB],
	minDistanceM: 100,
	count: 2,
	action: 'kick',
	banDays: 0,
	banScope: 'server',
	reason: 'Impossible kill: {weapon} from {distance} m.',
	cooldownMinutes: 30,
	...c
});
const MIN = 60_000;
const A = '76561198000000001';
const B = '76561198000000002';

describe('validateKillDistance', () => {
	test('needs a weapon, each a kill feed tag', () => {
		expect(() => validateKillDistance({})).toThrow('at least one weapon');
		expect(() => validateKillDistance({ causes: ['', '  '] })).toThrow('at least one weapon');
		expect(() => validateKillDistance({ causes: ['Defib <b>'] })).toThrow('kill feed tag');
		expect(() =>
			validateKillDistance({ causes: Array.from({ length: 41 }, (_, i) => `Id.Item.W${i}`) })
		).toThrow('at most 40');
	});
	test('fills defaults: the second kill in a match from 100 m, a flag', () => {
		expect(validateKillDistance({ causes: [DEFIB] })).toEqual({
			causes: [DEFIB],
			minDistanceM: 100,
			count: 2,
			action: 'flag',
			banDays: 0,
			banScope: 'server',
			reason: 'Impossible kill: {weapon} from {distance} m.',
			cooldownMinutes: 30
		});
	});
	test('clamps, drops a weapon named twice in another case, takes a list as text, keeps nothing else', () => {
		const c = validateKillDistance({
			causes: `${DEFIB}\nid.item.defibrillator.standard, Id.Item.Fists`,
			minDistanceM: -5,
			count: 500,
			banDays: -4,
			cooldownMinutes: 0,
			windowMinutes: 5
		});
		expect(c).toMatchObject({
			causes: [DEFIB, 'Id.Item.Fists'],
			minDistanceM: 0,
			count: 100,
			banDays: 0,
			cooldownMinutes: 1
		});
		expect('windowMinutes' in c).toBe(false);
	});
	test('a text left blank: a warning says what is not allowed, a kick or ban why', () => {
		expect(validateKillDistance({ causes: [DEFIB], action: 'warn', reason: ' ' }).reason).toBe(
			'{weapon} is not allowed on this server.'
		);
		for (const action of ['flag', 'kick', 'ban'])
			expect(validateKillDistance({ causes: [DEFIB], action }).reason).toBe(
				'Impossible kill: {weapon} from {distance} m.'
			);
		// a text written is kept, whatever the action
		expect(validateKillDistance({ causes: [DEFIB], action: 'warn', reason: 'No.' }).reason).toBe(
			'No.'
		);
	});
	test('an action or a list it does not know is a flag on this server', () => {
		for (const action of ['BAN', 'Kick', 'nuke', 1, null])
			expect(validateKillDistance({ causes: [DEFIB], action }).action).toBe('flag');
		expect(validateKillDistance({ causes: [DEFIB], action: 'ban' }).action).toBe('ban');
		expect(validateKillDistance({ causes: [DEFIB], action: 'warn' }).action).toBe('warn');
		expect(validateKillDistance({ causes: [DEFIB], action: 'WARN' }).action).toBe('flag');
		expect(validateKillDistance({ causes: [DEFIB], banScope: 'ORG' }).banScope).toBe('server');
		expect(validateKillDistance({ causes: [DEFIB], banScope: 'org' }).banScope).toBe('org');
		// the capability check reads raw settings the same way
		expect(killDistanceAction('ban')).toBe('flag');
		expect(killDistanceAction({ action: 'ban' })).toBe('ban');
		expect(killDistanceAction({ action: 'warn' })).toBe('warn');
		expect(killDistanceBanScope(['org'])).toBe('server');
	});
	test('the settings key changes with any setting and not with key order', () => {
		const a = validateKillDistance({ causes: [DEFIB], minDistanceM: 1 });
		const b = validateKillDistance({ minDistanceM: 1, causes: [DEFIB] });
		expect(killDistanceSettingsKey(a)).toBe(killDistanceSettingsKey(b));
		const c = validateKillDistance({ causes: [DEFIB], minDistanceM: 100 });
		expect(killDistanceSettingsKey(c)).not.toBe(killDistanceSettingsKey(a));
	});
	test('the settings key is a short hash, the same for a config however its keys are ordered', () => {
		const built = cfg();
		// the same settings as the database hands them back: jsonb keeps keys in its own order
		const stored = Object.fromEntries(
			Object.entries(built).sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
		) as KillDistanceConfig;
		expect(Object.keys(stored)).not.toEqual(Object.keys(built));
		expect(killDistanceSettingsKey(stored)).toBe(killDistanceSettingsKey(built));
		expect(killDistanceSettingsKey(built)).toMatch(/^[A-Za-z0-9_-]{16}$/);
	});
});

describe('countsForDistance', () => {
	const c = cfg();
	const k = (over: Partial<Parameters<typeof countsForDistance>[1]> = {}) =>
		countsForDistance(c, { killer: A, suicide: false, cause: DEFIB, distanceM: 4057, ...over });
	test('a player’s kill with a chosen weapon from the distance on, in any case', () => {
		expect(k()).toBe(true);
		expect(k({ distanceM: 100 })).toBe(true);
		expect(k({ cause: 'ID.ITEM.DEFIBRILLATOR.STANDARD' })).toBe(true);
	});
	test('not closer, another weapon, no distance, the environment or a suicide', () => {
		expect(k({ distanceM: 99.99 })).toBe(false);
		expect(k({ distanceM: 2 })).toBe(false);
		expect(k({ cause: 'Id.Item.AK74M' })).toBe(false);
		expect(k({ cause: 'Id.Item.Defibrillator' })).toBe(false);
		expect(k({ cause: null })).toBe(false);
		expect(k({ distanceM: null })).toBe(false);
		expect(k({ killer: null })).toBe(false);
		expect(k({ suicide: true })).toBe(false);
	});
	test('from 0 m every kill with a chosen weapon or vehicle, one sent without a distance too', () => {
		const HUMVEE_M249 = 'Id.Vehicle.WeaponExtension.WHL_05.RingTurret';
		const HUMVEE = 'Vehicle.Variant.Land.Wheeled.Humvee.MachineGun';
		const any = cfg({ minDistanceM: 0, causes: [HUMVEE_M249, HUMVEE] });
		const at = (over: Partial<Parameters<typeof countsForDistance>[1]>) =>
			countsForDistance(any, { killer: A, suicide: false, cause: HUMVEE_M249, ...over } as never);
		expect(at({ distanceM: 35 })).toBe(true);
		expect(at({ distanceM: 0 })).toBe(true);
		expect(at({ distanceM: null })).toBe(true);
		expect(at({ cause: HUMVEE, distanceM: null })).toBe(true);
		// still a player's kill with one of its weapons
		expect(at({ cause: 'Id.Item.M249', distanceM: 35 })).toBe(false);
		expect(at({ killer: null, distanceM: 35 })).toBe(false);
		expect(at({ suicide: true, distanceM: null })).toBe(false);
		// from 1 m a kill without a distance does not count
		expect(
			countsForDistance(cfg({ minDistanceM: 1, causes: [HUMVEE] }), {
				killer: A,
				suicide: false,
				cause: HUMVEE,
				distanceM: null
			})
		).toBe(false);
	});
});

describe('matchKey', () => {
	test('the stamped match, or the hour a kill came in when none was open', () => {
		expect(matchKey(41, 0)).toBe('m41');
		expect(matchKey(null, 3600_000 * 5 + 10)).toBe('h5');
		expect(matchKey(null, 3600_000 * 5 + 10)).not.toBe(matchKey(null, 3600_000 * 6));
	});
});

describe('killDistanceStep', () => {
	test('catches at the count, however far apart the kills were', () => {
		const tracks: DistanceTracks = new Map();
		const c = cfg({ count: 3 });
		expect(killDistanceStep(c, tracks, A, 0)).toBeNull();
		expect(killDistanceStep(c, tracks, A, 20 * MIN)).toBeNull();
		expect(killDistanceStep(c, tracks, A, 40 * MIN)).toBe(3);
		// another player's count is their own
		expect(killDistanceStep(c, tracks, B, 40 * MIN)).toBeNull();
	});
	test('one kill is enough when the count is one', () => {
		expect(killDistanceStep(cfg({ count: 1 }), new Map(), A, 0)).toBe(1);
	});
	test('a kick or ban leaves the player a minute on the panel’s clock, then acts at the next such kill', () => {
		for (const action of ['kick', 'ban'] as const) {
			const tracks: DistanceTracks = new Map();
			const c = cfg({ action, count: 1 });
			const now = 1_000_000;
			expect(killDistanceStep(c, tracks, A, now)).toBe(1);
			// the rest of a batch the game held back: taken in at the same moment, nothing more
			expect(killDistanceStep(c, tracks, A, now)).toBeNull();
			expect(killDistanceStep(c, tracks, A, now)).toBeNull();
			expect(killDistanceStep(c, tracks, A, now + ACT_AGAIN_MS - 1)).toBeNull();
			// back after the kick and at it again
			expect(killDistanceStep(c, tracks, A, now + ACT_AGAIN_MS)).toBe(5);
		}
	});
	test('a flag or a warning waits out its cooldown', () => {
		for (const action of ['flag', 'warn'] as const) {
			const tracks: DistanceTracks = new Map();
			const c = cfg({ action, cooldownMinutes: 30 });
			killDistanceStep(c, tracks, A, 0);
			expect(killDistanceStep(c, tracks, A, MIN)).toBe(2);
			expect(killDistanceStep(c, tracks, A, 20 * MIN)).toBeNull();
			expect(killDistanceStep(c, tracks, A, 31 * MIN)).toBe(4);
		}
	});
});

describe('killDistanceVerdict and killDistanceReplay', () => {
	test('names the weapon and the distance, and the count when more than one was asked for', () => {
		expect(killDistanceVerdict(cfg({ count: 1 }), DEFIB, 4057.4, 1)).toBe(
			'Defibrillator kill from 4057 m'
		);
		expect(killDistanceVerdict(cfg({ count: 2 }), DEFIB, 4056.6, 3)).toBe(
			'Defibrillator kill from 4057 m (3 this match)'
		);
	});
	test('a kill the feed sent without a distance is told without one', () => {
		const roadkill = 'Vehicle.Variant.Land.Wheeled.Humvee.Default';
		expect(killDistanceVerdict(cfg({ count: 1, minDistanceM: 0 }), roadkill, null, 1)).toBe(
			'Humvee kill'
		);
		expect(killDistanceVerdict(cfg({ count: 3, minDistanceM: 0 }), roadkill, null, 3)).toBe(
			'Humvee kill (3 this match)'
		);
	});
	test('replays per match, in the order the kills came in', () => {
		const at = (m: number, match: string, steamId = A) => ({
			at: m * MIN,
			match,
			steamId,
			name: 'x',
			cause: DEFIB,
			distanceM: 4057
		});
		const out = killDistanceReplay(cfg({ count: 2, action: 'kick' }), [
			// one each in two matches: not caught
			at(0, 'm1'),
			at(50, 'm2'),
			// B's two in one match, far apart: caught at the second
			at(51, 'm2', B),
			at(90, 'm2', B)
		]);
		expect(out.map((o) => [o.steamId, o.at, o.count])).toEqual([[B, 90 * MIN, 2]]);
	});
});
