// The kill feed on the database side: each server's feed token, which batch belongs to which
// server, and how a batch becomes rows in `kills`. Inbound data from the game process, so it runs
// on the web role and writes Postgres directly; the worker's lane is for requests Warcon makes.
import {
	and,
	count,
	desc,
	eq,
	gt,
	gte,
	lte,
	ilike,
	inArray,
	isNull,
	lt,
	or,
	sql,
	type SQL
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Env } from './env';
import { decryptSecret, encryptSecret } from './crypto';
import { ApiError } from './http';
import { writeAudit } from './audit';
import {
	kills,
	feedEvents,
	feedClocks,
	matches,
	playerSessions,
	serverLive,
	servers,
	type KillRow,
	type ServerRow
} from './db/schema';
import type { KillView } from '$lib/types';
import { VEHICLE_TAGS, type KillFilter } from '$lib/kills';
import type { SessionUser } from './access';
import { FEED_TOKEN_PREFIX, isTeamKill, parseBatch, type ParsedKill } from './feed-core';
import { FEED_HISTORY_MAX_MS, feedReceipt, resolveFeedClock, stampFeedKill } from './feed-time';

const hashToken = (token: string): string =>
	createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * What goes in [WDServerFeed] Url: the panel's origin alone. The game appends /api/ingest/events
 * to whatever Url holds (CL-501228), so the route lives at that path.
 */
export const feedUrl = (env: Pick<Env, 'ORIGIN'>): string => env.ORIGIN;

export interface FeedSetup {
	configured: boolean;
	url: string;
	/** the token, for org owners only; '' otherwise */
	token: string;
	feedAt: string | null;
}

export async function feedSetup(env: Env, server: ServerRow, reveal: boolean): Promise<FeedSetup> {
	const [live] = await env.db
		.select({ feedAt: serverLive.feedAt })
		.from(serverLive)
		.where(eq(serverLive.serverId, server.id));
	return {
		configured: !!server.feedTokenHash,
		url: feedUrl(env),
		token: reveal && server.feedTokenEnc ? decryptSecret(env, server.feedTokenEnc) : '',
		feedAt: live?.feedAt ? live.feedAt.toISOString() : null
	};
}

/** A new token for the server (replacing any it had), audited. */
export async function mintFeedToken(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow
): Promise<string> {
	const token = FEED_TOKEN_PREFIX + randomBytes(32).toString('base64url');
	await env.db
		.update(servers)
		.set({ feedTokenEnc: encryptSecret(env, token), feedTokenHash: hashToken(token) })
		.where(eq(servers.id, server.id));
	tokenCache.clear();
	await writeAudit(env, req, {
		actor,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: server.feedTokenHash ? 'feed.rotate' : 'feed.enable',
		outcome: 'ok'
	});
	return token;
}

export async function removeFeedToken(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow
): Promise<void> {
	if (!server.feedTokenHash) throw new ApiError(400, 'This server has no kill feed token.');
	await env.db
		.update(servers)
		.set({ feedTokenEnc: null, feedTokenHash: null })
		.where(eq(servers.id, server.id));
	tokenCache.clear();
	await writeAudit(env, req, {
		actor,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'feed.disable',
		outcome: 'ok'
	});
}

// A busy fleet posts many times a second; the token is looked up once a minute per process.
const TOKEN_TTL_MS = 60_000;
const tokenCache = new Map<string, { serverId: string; until: number }>();

/** The server a feed bearer belongs to, or null. */
export async function resolveFeedToken(env: Env, token: string): Promise<string | null> {
	const hash = hashToken(token);
	const hit = tokenCache.get(hash);
	if (hit && hit.until > Date.now()) return hit.serverId;
	const [row] = await env.db
		.select({ id: servers.id })
		.from(servers)
		.where(eq(servers.feedTokenHash, hash));
	if (!row) return null;
	tokenCache.set(hash, { serverId: row.id, until: Date.now() + TOKEN_TTL_MS });
	return row.id;
}

/** Test-only. */
export const forgetFeedTokens = (): void => tokenCache.clear();

const FEED_AT_EVERY_MS = 10_000;
const feedAtWritten = new Map<string, number>();

export interface IngestResult {
	accepted: number;
	skipped: number;
	duplicates: number;
	/** what was written, in feed order */
	kills: KillView[];
	receipt: {
		packetReceivedAt: string;
		warconReceivedAt: string;
		sourceReceivedAt: string | null;
		relaySourceId: string | null;
	};
	timing: {
		clock: number;
		ambiguous: number;
		historical: number;
		moderationEligible: number;
		reason: string | null;
	};
}

export function killView(r: KillRow): KillView {
	return {
		eventId: r.eventId,
		ts: r.ts.toISOString(),
		eventAt: r.eventAt?.toISOString() ?? null,
		packetReceivedAt: r.packetReceivedAt?.toISOString() ?? null,
		warconReceivedAt: r.warconReceivedAt?.toISOString() ?? null,
		sourceReceivedAt: r.sourceReceivedAt,
		timeQuality: r.timeQuality,
		clockId: r.clockId,
		matchRow: r.matchRow,
		historical: r.historical,
		moderationEligible: r.moderationEligible,
		map: r.map,
		eventTime: r.eventTime,
		killer: r.killerSteamId
			? { steamId: r.killerSteamId, name: r.killerName ?? '', faction: r.killerFaction }
			: null,
		victim: { steamId: r.victimSteamId, name: r.victimName, faction: r.victimFaction },
		cause: r.cause,
		distanceM: r.distanceM,
		headshot: r.headshot,
		suicide: r.suicide,
		teamKill: r.teamKill,
		tags: Array.isArray(r.tags) ? (r.tags as string[]) : []
	};
}

/**
 * Writes one batch atomically with its permanent dedupe ledger and clock state. `now` is
 * Warcon's receipt, independent of the trusted relay's original receipt.
 */
export async function ingestBatch(
	env: Env,
	serverId: string,
	body: unknown,
	now = new Date(),
	relayToken?: string | null
): Promise<IngestResult> {
	const receipt = feedReceipt(env.FEED_RELAY_SOURCES, serverId, body, now, relayToken);
	let batch;
	try {
		batch = parseBatch(body);
	} catch (err) {
		throw new ApiError(400, err instanceof Error ? err.message : 'Malformed batch.');
	}
	let fresh: ParsedKill[] = batch.kills;
	let duplicates = 0;
	let written: KillView[] = [];
	let reason: string | null = null;
	if (fresh.length)
		// The ordinary ledger has a permanent (server,event) key; the hypertable cannot. The
		// server lock also serialises clock transitions with dedupe and kill insertion.
		await env.db.transaction(async (db) => {
			await db.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${'feed:' + serverId}, 0))`
			);
			const ids = [...new Set(fresh.map((k) => k.eventId))];
			const seen = new Set(
				(
					await db
						.select({ eventId: feedEvents.eventId })
						.from(feedEvents)
						.where(and(eq(feedEvents.serverId, serverId), inArray(feedEvents.eventId, ids)))
				).map((r) => r.eventId)
			);
			const once = new Set<string>();
			fresh = fresh.filter((k) => {
				if (seen.has(k.eventId) || once.has(k.eventId)) return false;
				once.add(k.eventId);
				return true;
			});
			duplicates = batch.kills.length - fresh.length;
			if (!fresh.length) return;
			const steamIds = [
				...new Set(
					fresh.flatMap((k) =>
						k.killerSteamId ? [k.killerSteamId, k.victimSteamId] : [k.victimSteamId]
					)
				)
			];
			const [open, observed, clocks] = await Promise.all([
				db
					.select({ steamId: playerSessions.steamId, faction: playerSessions.faction })
					.from(playerSessions)
					.where(
						and(
							eq(playerSessions.serverId, serverId),
							isNull(playerSessions.leftAt),
							inArray(playerSessions.steamId, steamIds)
						)
					)
					.orderBy(playerSessions.id),
				db
					.select({ id: matches.id, map: matches.map, endedAt: matches.endedAt })
					.from(matches)
					.where(
						and(
							eq(matches.serverId, serverId),
							lte(matches.startedAt, receipt.packetReceivedAt),
							or(isNull(matches.endedAt), gt(matches.endedAt, receipt.packetReceivedAt))
						)
					)
					.limit(2),
				db
					.select()
					.from(feedClocks)
					.where(
						and(
							eq(feedClocks.serverId, serverId),
							gte(
								feedClocks.lastReceiptAt,
								new Date(now.getTime() - FEED_HISTORY_MAX_MS - 7 * 86400_000)
							)
						)
					)
			]);
			const matchRow =
				observed.length === 1 && observed[0].map === batch.kills[0]?.map ? observed[0].id : null;
			const resolved =
				observed.filter((m) => m.map === batch.kills[0]?.map).length > 1
					? { clock: null, create: false, close: null, reason: 'overlapping_observed_rounds' }
					: resolveFeedClock(
							clocks,
							batch,
							receipt,
							matchRow,
							randomUUID(),
							matchRow !== null ? observed[0].endedAt : null
						);
			reason = resolved.reason;
			if (resolved.close)
				await db
					.update(feedClocks)
					.set({ endedAt: receipt.packetReceivedAt })
					.where(eq(feedClocks.id, resolved.close));
			if (resolved.clock) {
				if (resolved.create) await db.insert(feedClocks).values({ ...resolved.clock, serverId });
				else
					await db
						.update(feedClocks)
						.set({
							matchRow: resolved.clock.matchRow,
							endedAt: resolved.clock.endedAt,
							lastReceiptAt: resolved.clock.lastReceiptAt,
							maxEventTime: resolved.clock.maxEventTime
						})
						.where(eq(feedClocks.id, resolved.clock.id));
			}
			await db
				.insert(feedEvents)
				.values(fresh.map((k) => ({ serverId, eventId: k.eventId, firstReceivedAt: now })));
			// Newest open session wins when a player somehow has two.
			const faction = new Map<string, string | null>();
			for (const s of open) faction.set(s.steamId, s.faction);
			const rows = await db
				.insert(kills)
				.values(
					fresh.map((k) => {
						const stamp = stampFeedKill(receipt, resolved.clock, k.eventTime);
						// Current player factions are not evidence about a historical kill.
						const kf =
							stamp.moderationEligible && k.killerSteamId
								? (faction.get(k.killerSteamId) ?? null)
								: null;
						const vf = stamp.moderationEligible ? (faction.get(k.victimSteamId) ?? null) : null;
						return {
							...stamp,
							...receipt,
							serverId,
							eventId: k.eventId,
							instanceId: batch.instanceId,
							matchId: k.matchId,
							matchRow:
								stamp.eventAt && !resolved.reason ? (resolved.clock?.matchRow ?? matchRow) : null,
							eventTime: k.eventTime,
							map: k.map,
							killerSteamId: k.killerSteamId,
							killerName: k.killerName,
							killerFaction: kf,
							victimSteamId: k.victimSteamId,
							victimName: k.victimName,
							victimFaction: vf,
							cause: k.cause,
							distanceM: k.distanceM,
							headshot: k.headshot,
							suicide: k.suicide,
							teamKill: isTeamKill(k, kf, vf),
							tags: k.tags
						};
					})
				)
				.returning();
			written = rows.map(killView);
		});
	// The liveness stamp, at most every ten seconds per server: the worker's upsert of the row
	// leaves this column alone, so the two never fight.
	const last = feedAtWritten.get(serverId) ?? 0;
	if (now.getTime() - last >= FEED_AT_EVERY_MS) {
		feedAtWritten.set(serverId, now.getTime());
		await env.db
			.insert(serverLive)
			.values({ serverId, feedAt: now })
			.onConflictDoUpdate({ target: serverLive.serverId, set: { feedAt: now } });
	}
	return {
		accepted: fresh.length,
		skipped: batch.skipped,
		duplicates,
		kills: written,
		receipt: {
			packetReceivedAt: receipt.packetReceivedAt.toISOString(),
			warconReceivedAt: now.toISOString(),
			sourceReceivedAt: receipt.sourceReceivedAt,
			relaySourceId: receipt.relaySourceId
		},
		timing: {
			clock: written.filter((k) => k.timeQuality === 'clock').length,
			ambiguous: written.filter((k) => k.timeQuality === 'ambiguous').length,
			historical: written.filter((k) => k.historical).length,
			moderationEligible: written.filter((k) => k.moderationEligible).length,
			reason
		}
	};
}

const STEAM_RE = /^\d{17}$/;
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/** One side of a kill: a SteamID exactly, else part of the name. Mirrors sideMatches in $lib/kills. */
const sideIs = (needle: string, steamId: AnyPgColumn, name: AnyPgColumn) =>
	STEAM_RE.test(needle) ? eq(steamId, needle) : ilike(name, `%${likeEscape(needle)}%`);

/** A stable page boundary: (ts,eventTime,eventId); the older two-part cursor remains accepted. */
export interface KillsBefore {
	ts: Date;
	eventTime: number | null;
	eventId?: string | null;
}

/** One match's kills: the rows carrying its match row, within its window on (server_id, ts). */
export interface KillsOfMatch {
	matchRow: number;
	from: Date;
	to: Date | null;
}

/** The rows of one server the filter asks for, older than `before` when given, of one match when given. */
function killWhere(
	serverId: string,
	before: KillsBefore | null,
	f: KillFilter,
	match: KillsOfMatch | null = null
): SQL {
	const conds: (SQL | undefined)[] = [eq(kills.serverId, serverId)];
	if (match) {
		conds.push(eq(kills.matchRow, match.matchRow), gte(kills.ts, match.from));
		if (match.to) conds.push(lte(kills.ts, match.to));
	}
	// Same-frame kills can share both event time fields; eventId breaks that tie without loss.
	if (before)
		conds.push(
			before.eventTime === null
				? lt(kills.ts, before.ts)
				: before.eventId
					? sql`(${kills.ts}, ${kills.eventTime}, ${kills.eventId} COLLATE "C") < (${before.ts}, ${before.eventTime}, ${before.eventId})`
					: sql`(${kills.ts}, ${kills.eventTime}) < (${before.ts}, ${before.eventTime})`
		);
	if (f.killer) conds.push(sideIs(f.killer, kills.killerSteamId, kills.killerName));
	if (f.victim) conds.push(sideIs(f.victim, kills.victimSteamId, kills.victimName));
	if (f.player)
		conds.push(
			or(
				sideIs(f.player, kills.killerSteamId, kills.killerName),
				sideIs(f.player, kills.victimSteamId, kills.victimName)
			)
		);
	if (f.cause) conds.push(sql`lower(${kills.cause}) = lower(${f.cause})`);
	if (f.minM !== null) conds.push(gte(kills.distanceM, f.minM));
	switch (f.kind) {
		case 'headshot':
			conds.push(eq(kills.headshot, true));
			break;
		case 'teamKill':
			conds.push(eq(kills.teamKill, true));
			break;
		case 'suicide':
			conds.push(eq(kills.suicide, true));
			break;
		case 'environment':
			conds.push(isNull(kills.killerSteamId));
			break;
		case 'vehicle':
			conds.push(
				or(
					ilike(kills.cause, 'Vehicle.%'),
					ilike(kills.cause, 'Id.Vehicle.%'),
					sql`${kills.tags} ?| ${sql.raw(`ARRAY[${VEHICLE_TAGS.map((t) => `'${t}'`).join(',')}]`)}`
				)
			);
			break;
	}
	return and(...conds)!;
}

/** The newest `limit` kills on a server the filter asks for, older than `before` when given. */
export async function recentKills(
	env: Env,
	serverId: string,
	before: KillsBefore | null,
	limit: number,
	filter: KillFilter,
	match: KillsOfMatch | null = null
): Promise<KillView[]> {
	const rows = await env.db
		.select()
		.from(kills)
		.where(killWhere(serverId, before, filter, match))
		.orderBy(desc(kills.ts), desc(kills.eventTime), desc(sql`${kills.eventId} COLLATE "C"`))
		.limit(limit);
	return rows.map(killView);
}

/** How many kills on the server the filter asks for, over the whole history. */
export async function countKills(
	env: Env,
	serverId: string,
	filter: KillFilter,
	match: KillsOfMatch | null = null
): Promise<number> {
	const [row] = await env.db
		.select({ n: count() })
		.from(kills)
		.where(killWhere(serverId, null, filter, match));
	return row?.n ?? 0;
}
