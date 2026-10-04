// The Kill rate rule's pure part: which kills it counts, when a player's recent kills flag them,
// and the per-player window it keeps. Flag only: the kill feed has no position, aim or input, so
// a high rate is a reason for staff to look, never proof. No database, no game server; the live
// path (feed-events.ts) and the dry run (triggers.ts) run the same step.
import { ApiError, int } from './http';
import { causeKind } from '$lib/causes';

/** The outbox action of a Kill rate flag: a panel action, nothing is sent to the game. */
export const KILL_RATE_FLAG = 'kill_rate_flag';

export interface KillRateConfig {
	/** the window a player's kills are counted over */
	windowMinutes: number;
	/** flag at this many kills in the window; 0 is off */
	maxKills: number;
	/** flag at this share of headshots (percent) over the window's kills; 0 is off */
	headshotPct: number;
	/** the headshot share is judged from this many kills in the window */
	headshotMinKills: number;
	/** a flagged player is not flagged again by the rule for this long */
	cooldownMinutes: number;
}

export function validateKillRate(c: Record<string, unknown>): KillRateConfig {
	const cfg: KillRateConfig = {
		windowMinutes: int(c.windowMinutes, 5, 1, 60),
		maxKills: int(c.maxKills, 0, 0, 1000),
		headshotPct: int(c.headshotPct, 0, 0, 100),
		headshotMinKills: int(c.headshotMinKills, 15, 1, 1000),
		cooldownMinutes: int(c.cooldownMinutes, 30, 1, 24 * 60)
	};
	if (!cfg.maxKills && !cfg.headshotPct)
		throw new ApiError(400, 'Set a kill count, a headshot share, or both.');
	return cfg;
}

/** A kill the rule counts: a player's, with a hand-held weapon (not a vehicle, its gun or a buildable), not a suicide. */
export function countsForRate(k: {
	killer: string | null | undefined;
	suicide: boolean;
	cause: string | null;
}): boolean {
	return !!k.killer && !k.suicide && causeKind(k.cause) === 'weapon';
}

/** Why `kills` in the window, `headshots` of them, flag a player; null when they do not. */
export function killRateVerdict(
	cfg: KillRateConfig,
	kills: number,
	headshots: number
): string | null {
	const within = `in ${cfg.windowMinutes} min`;
	if (cfg.maxKills && kills >= cfg.maxKills)
		return `${kills} kill${kills === 1 ? '' : 's'} ${within}`;
	if (cfg.headshotPct && kills >= cfg.headshotMinKills) {
		const pct = Math.round((100 * headshots) / kills);
		if (pct >= cfg.headshotPct) return `${pct}% headshots over ${kills} kills ${within}`;
	}
	return null;
}

/** One player's counted kills inside the window (ms, oldest first) and when the rule last flagged them. */
export interface RateTrack {
	at: number[];
	head: boolean[];
	flaggedAt: number | null;
}
export type RateTracks = Map<string, RateTrack>;

/**
 * Adds one counted kill at `at` (ms) to its killer's window and returns the verdict when it
 * flags them now. The window is judged at the player's latest kill, so a kill that arrives late
 * (a batch that finished after the next one) lands in its place rather than on top.
 */
export function killRateStep(
	cfg: KillRateConfig,
	tracks: RateTracks,
	steamId: string,
	at: number,
	headshot: boolean
): string | null {
	let t = tracks.get(steamId);
	if (!t) {
		t = { at: [], head: [], flaggedAt: null };
		tracks.set(steamId, t);
	}
	let i = t.at.length;
	while (i > 0 && t.at[i - 1] > at) i--;
	t.at.splice(i, 0, at);
	t.head.splice(i, 0, headshot);
	const newest = t.at[t.at.length - 1];
	const from = newest - cfg.windowMinutes * 60_000;
	while (t.at.length && t.at[0] <= from) {
		t.at.shift();
		t.head.shift();
	}
	if (t.flaggedAt !== null && newest - t.flaggedAt < cfg.cooldownMinutes * 60_000) return null;
	const verdict = killRateVerdict(cfg, t.at.length, t.head.filter(Boolean).length);
	if (verdict) t.flaggedAt = newest;
	return verdict;
}

/** Forgets players with nothing left in the window and no cooldown running, so memory follows who is fighting. */
export function pruneTracks(cfg: KillRateConfig, tracks: RateTracks, now: number): void {
	const from = now - cfg.windowMinutes * 60_000;
	const cooled = now - cfg.cooldownMinutes * 60_000;
	for (const [id, t] of tracks) {
		const last = t.at.length ? t.at[t.at.length - 1] : -Infinity;
		if (last <= from && (t.flaggedAt === null || t.flaggedAt <= cooled)) tracks.delete(id);
	}
}

export interface RateKill {
	at: number;
	clockId?: string;
	steamId: string;
	name: string;
	headshot: boolean;
}

/** The flags the rule would have raised over `kills` (counted kills, any order). */
export function killRateReplay(
	cfg: KillRateConfig,
	kills: RateKill[]
): (RateKill & { verdict: string })[] {
	const byClock = new Map<string, RateTracks>();
	const out: (RateKill & { verdict: string })[] = [];
	for (const k of [...kills].sort((a, b) => a.at - b.at)) {
		const clock = k.clockId ?? 'unspecified';
		let tracks = byClock.get(clock);
		if (!tracks) byClock.set(clock, (tracks = new Map()));
		const verdict = killRateStep(cfg, tracks, k.steamId, k.at, k.headshot);
		if (verdict) out.push({ ...k, verdict });
	}
	return out;
}
