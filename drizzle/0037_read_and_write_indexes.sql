-- Indexes for what runs most often, and none for what made every heartbeat expensive.
--
-- player_sessions: the heartbeat rewrites last_seen for everyone online every 30 s, and while
-- last_seen was indexed each rewrite was a new row version with an entry in all four indexes.
-- Without that index the rewrite changes no indexed column and can be a HOT update, which needs
-- room on the row's own page: new pages are now filled to 90%. Reads of "seen since" add
-- (left_at IS NULL OR left_at >= since), which closing a session makes equivalent (it sets
-- last_seen = left_at), and player_sessions_open_idx serves that.
--
-- matches_open_idx: the match in progress, read on every status look and every kill batch, was
-- found by reading all of the server's matches. outbox_pending_idx: only the rows still to deliver,
-- as json_webhook_posts already does; the rest are kept for good and never claimed again.
-- list_entries_expiry_idx: the worker's look for lapsed bans every few seconds. audit_target_idx:
-- a player's history on the dossier, which read every audit row of the org.
-- Order: the migrations run in one transaction that keeps every lock until it commits, so the
-- slow build (audit_log, which blocks only audit inserts) goes first and the locks that stop
-- everything on a table come last: outbox for its own index build, player_sessions for the last
-- moment, so heartbeats, joins and kill batches wait milliseconds, not the whole migration.
CREATE INDEX "audit_target_idx" ON "audit_log" USING btree ("target","id") WHERE "audit_log"."target" <> '';--> statement-breakpoint
CREATE INDEX "list_entries_expiry_idx" ON "list_entries" USING btree ("expires_at") WHERE "list_entries"."removed_at" is null and "list_entries"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "matches_open_idx" ON "matches" USING btree ("server_id","id") WHERE "matches"."ended_at" is null;--> statement-breakpoint
DROP INDEX "outbox_pending_idx";--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("state","not_before") WHERE "outbox"."state" in ('pending', 'sending');--> statement-breakpoint
DROP INDEX "player_sessions_seen_idx";--> statement-breakpoint
ALTER TABLE "player_sessions" SET (fillfactor = 90);
