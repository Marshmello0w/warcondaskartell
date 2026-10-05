# Upstream integration (PR #5)

The upstream improvements are merged into the fork with its existing feed timing and clan-only
automation intact. Automatic Team balance and Clan teams moves use the game's team change without
an additional kill request, including outbox rows queued before this upgrade.

Team balance still discovers the closed faction every 30 seconds and retries unconfirmed moves
after 15 seconds. All move reasons share ten attempts per player in a rolling ten-minute window.
A placement observed on its intended side for 30 seconds resets that budget; a brief return does
not. Clan teams remains an independent mode that groups clan tags without balancing or closing a
faction. AFK protection remains removed.

## Database upgrade

`0037_feed_event_times` and its journal timestamp (`1791129692378`) were already deployed and must
remain unchanged. Upstream's index and player-totals migrations had earlier journal timestamps,
which Drizzle would skip on an upgraded database even if their files were renamed. They are now
`0038_read_and_write_indexes` and `0039_player_totals`, with journal timestamps after the applied
feed migration. Their snapshots include the feed tables and provenance columns as well as the
upstream schema changes.

Run the migration step before starting the updated web and worker processes, as for other schema
updates. The upgrade builds player totals from existing session and match history. It does not
rewrite old kill timestamps, match assignments, clock anchors or the permanent event ledger.
Stats purges take the totals lock before the feed lock, reset affected clocks and retain event IDs
so delayed retries cannot resurrect deleted kills. Cached boards are invalidated after the purge.

`src/test/merge-migrations.test.ts` verifies migration chronology, an upgrade from the deployed
feed schema with existing history, and a second migration run that applies nothing.
`src/test/player-totals-writes.test.ts` verifies existing history, totals and concurrent writes.
The relay contract remains documented in [feed-relay.md](feed-relay.md); historical and ambiguous
feed events are excluded from current moderation, including the new optional Kill distance kill
action.
