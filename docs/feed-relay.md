# Forwarded WarDogs kill feed

Warcon accepts the original game packet at `POST /api/ingest/events`. A forwarding bot must
record **its own first receipt of each original packet**, before queuing or doing other work,
and add `sourceReceivedAt` at the **top level of that packet**, beside `serverId`, `serverName`
and `events`. It is not an event property. The game payload's `serverId` remains the game's
per-boot instance ID; do not replace it with the Warcon server ID.

```json
{
  "serverId": "e9cf2544-b21e-4b80-9f12-8ec95ff58964",
  "serverName": "My WarDogs server",
  "sourceReceivedAt": "2026-10-04T15:24:56.665091Z",
  "events": [
    {
      "eventId": "74858043-967c-45f8-94b2-7e91c45fc097",
      "type": "killed",
      "eventTime": 3317.77,
      "matchId": "7e72e869-4460-4d27-aa4c-76a52ed20cb4",
      "mapName": "Kavkazi",
      "killerSteamId": "76561198000000001",
      "killerName": "Alpha",
      "victimSteamId": "76561198000000002",
      "victimName": "Bravo",
      "cause": "Id.Item.AK74M",
      "distance": 3000,
      "contextTags": []
    }
  ]
}
```

## Trust and authentication

By default **no external source may supply timestamps**. Configure a separate randomly generated
base64url relay secret of at least 32 bytes (43 characters), independent of the game's feed token
and the internal web/worker `RELAY_SECRET`. Set this JSON array in the Warcon environment and
restart the processes:

```dotenv
FEED_RELAY_SOURCES='[{"id":"wardogs-bot","serverId":"WARCON-SERVER-ID","token":"YOUR_RANDOM_BASE64URL_SECRET_OF_AT_LEAST_43_CHARACTERS"}]'
```

`serverId` here is the server's **Warcon ID** (from the panel/API). Each entry allows only that
relay secret on that server. IDs and tokens must be unique in the array; `direct` is reserved.
For another server create another entry and another secret. Invalid configuration stops startup
without printing its secrets. Docker Compose already passes `.env` to the web and worker roles.

The bot sends both headers over HTTPS:

```http
Authorization: Bearer wkf_<the server's existing feed token>
X-Warcon-Relay-Token: <the configured independent relay secret>
Content-Type: application/json
```

The first credential identifies the Warcon server. The second expressly authorises the source
timestamp. A normal feed token alone cannot authorise `sourceReceivedAt`. A timestamp without
the matching configured relay credential receives **403 `untrusted_feed_relay`**. An unknown
normal feed credential still receives **401 `unauthorized`**. An authenticated relay request
without `sourceReceivedAt` receives **400 `missing_source_time`**.

Direct game-server requests keep their existing bearer and omit **both** the new field and relay
header. They remain supported; their original receipt equals Warcon's receipt. Omitting both
cannot identify a forwarding bot, so the bot must always use the relay contract, including on
immediate deliveries. Do not send the independent relay secret back to the game server.

## Accepted timestamps and limits

`sourceReceivedAt` must be a JSON string in this strict RFC3339/ISO-8601 subset. An occurrence
inside an event is rejected with **400 `misplaced_source_time`**, rather than falling back to a
direct receipt:

- `YYYY-MM-DDTHH:mm:ssZ`, optionally with **1–9 fractional second digits**.
- The timezone can instead be an explicit `+HH:mm` or `-HH:mm` offset, up to `±14:00`.
- Examples: `2026-10-04T15:24:56Z`, `2026-10-04T15:24:56.665091Z`,
  `2026-10-04T17:24:56.665091+02:00` describe allowed forms.
- The calendar date must exist. Missing timezone, a space instead of `T`, lowercase `z`,
  leap seconds, `24:00`, `-00:00` (unknown offset), numeric epochs, null and empty strings are
  rejected with **400 `invalid_source_time`**.
- A source receipt more than **2 seconds ahead** of Warcon's actual receipt is rejected with
  **400 `future_source_time`**. Synchronise the bot's and Warcon's clocks.
- A source receipt more than **30 days old** is rejected with **400 `stale_source_time`**.
  This is an explicit acceptance limit, not an automatic replacement with the current time.

Warcon retains the original string, including microseconds and offset. Date arithmetic, stored
UTC times and the UI use milliseconds; extra fractional digits are truncated, not fabricated.
The existing packet limits (200 events, 64 KiB) and per-server rate limit still apply.

## Acceptance acknowledgement and retries

A **200** response is sent after the database transaction committed:

```json
{
  "ok": true,
  "accepted": 1,
  "skipped": 0,
  "duplicates": 0,
  "receipt": {
    "sourceReceivedAt": "2026-10-04T15:24:56.665091Z",
    "packetReceivedAt": "2026-10-04T15:24:56.665Z",
    "warconReceivedAt": "2026-10-04T15:30:00.000Z",
    "relaySourceId": "wardogs-bot"
  },
  "timing": {
    "clock": 1,
    "ambiguous": 0,
    "historical": 1,
    "moderationEligible": 0,
    "reason": null
  }
}
```

`accepted` counts newly stored kills, `duplicates` previously stored or repeated IDs in the
packet, and `skipped` unsupported/malformed events. The timing counts describe **newly stored**
kills; a packet consisting entirely of duplicates has zero timing counts. `receipt` always
confirms the authenticated submitted receipt, including duplicate/empty packets. A duplicate
does not restamp a kill or advance a clock. The response describes storage, not a guarantee that
an action ran or that a round was resolved. Unknown round timing is a successful storage result
(`ambiguous` > 0, `reason` explains why), not a reason to keep resending an accepted packet.

After a timeout, network failure, 429 or temporary 5xx, retry the **same original packet, event
IDs and sourceReceivedAt**, with backoff. A 200 with `accepted: 0` and the expected duplicates
also confirms delivery. Never remove/change the timestamp to turn a 400/403 into a direct feed
request. Log/quarantine permanent validation failures. Review `skipped` instead of assuming
every submitted event was a kill. Retain original packets individually when draining a queue;
**do not merge packets with different original receipt times under one timestamp**.

## Packet time, kill time and rounds

The fields stored for new kills have separate meanings:

| Field | Meaning |
| --- | --- |
| `packetReceivedAt` | Original game-packet receipt at the authenticated bot, or Warcon for direct feeds. |
| `warconReceivedAt` | Actual Warcon HTTP receipt, also used for feed liveness. |
| `sourceReceivedAt`, `relaySourceId` | Original submitted string and authenticated source identity. |
| `eventTime` | Unchanged game elapsed round seconds, not a UTC timestamp. |
| `eventAt` | Estimated UTC kill time only for a resolved round clock; otherwise null. |
| `ts` | Canonical display/order/analysis timestamp: `eventAt` when resolved, original packet receipt otherwise. |
| `timeQuality` | `clock` (clock-derived estimate), `ambiguous` (new unresolved data), `legacy` (untouched old data). |
| `clockId`, `matchRow` | Persistent clock epoch and independently observed round, when assignable. |
| `historical`, `moderationEligible` | Whether the delivery/kill was too old and whether live rules may use it. |

An unambiguous clock is anchored **once** as original receipt minus the packet's latest
`eventTime`. Later packets use that persisted origin, including after a Warcon restart and on
out-of-order delivery. Thus ten game minutes remain ten minutes when packets arrive together.
This is an **estimate**, subject to the game's first flush/transport delay, not an exact UTC
timestamp supplied by the game. The UI marks clock-derived times `≈`; unknown/legacy times are
labelled `received`, with an explanation. Timed combat analytics exclude ambiguous and legacy
receipt-only records and show their separate omitted count; they remain in the full kill history.
History pagination uses `before`, `beforeTime` and optional `beforeId` together so distinct
same-frame kills are not lost when their clock-derived timestamps tie.

The game `serverId` is a per-boot instance ID. Its `matchId` can stay unchanged across map/round
changes and is deliberately **not** used as a round key. Boots, map changes and independently
observed round transitions separate clocks. A same-map reset without a trustworthy observed
boundary, a packet mixing maps/reset clocks, an inconsistent clock jump or multiple possible
rounds remains ambiguous. A reset's uncertainty persists until an observed round/map/boot
boundary resolves it; future packets cannot silently revive the old anchor. Ordinary game
flushes allow up to 10 seconds of timing variation; outside that window a later packet is not
reanchored to its arrival. Original delivery buffering inside the game cannot always be
identified from its payload, especially on the first packet; the bot receipt is not proof of
the original kill's UTC time.

Kills or original packets over **30 seconds old** at receipt, and deliveries assigned to a
closed observed round/clock, are historical. They remain in the feed/history, but cannot trigger
Kill rate, Kill distance, Team kill actions or team-kill
Discord notifications, nor enter live rule counts. The worker checks freshness again when it
processes the message and excludes closed/replaced clocks/observed rounds. Historical kills
do not borrow current players' factions. Rate windows and previews use resolved event times
and separate round clocks rather than grouping kills by packet arrival. Feed liveness always
uses Warcon's actual receipt.

## Required bot change

The bot currently forwards game bodies unchanged. Its receive handler must copy the body and
attach its own timestamp **before** queueing, persist that decorated packet, and reuse it on
every retry. For example, at the original receive boundary in a Python bot:

```python
from copy import deepcopy
from datetime import datetime, timezone

received_at = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
forwarded_packet = deepcopy(game_packet)
forwarded_packet["sourceReceivedAt"] = received_at
# Persist/enqueue forwarded_packet here. The HTTP sender adds both authenticated headers.
# Never regenerate received_at when the queue is drained or a send is retried.
```

If packets already in the bot's queue have a trustworthy saved original receive time, attach
that time. If they have none, **do not invent one**: keep them separate for manual investigation
instead of sending them as new direct/live kills. This repository changes Warcon only; applying
this receive/queue/sender change in the bot is required to supply the missing original times.

## Upgrade and existing history

Migration `0037_feed_event_times` adds nullable receipt/event columns, clock state and a regular
table with a permanent `(server_id, event_id)` key outside the Timescale hypertable. It backfills
**only the dedupe ledger**, from all known event IDs; a database trigger maintains it for inserts
during deployment. Neither the ledger nor the clocks expire with a moderation cooldown. An
existing duplicate stays in history; the upgrade does not delete or rewrite old kills.

Old rows retain their original `ts`, match assignment and records. They are labelled `legacy`,
have no reconstructed `eventAt`, and cannot generate fabricated rate flags. There is no bulk
historical timestamp rewrite. A later repair would require retained original receipts, a unique
round/boot mapping and a verifiable clock anchor for those exact records; the old receipt plus
an unreliable `matchId` alone is insufficient.

An explicit stats purge resets that server's clock state under the ingest lock and retains the
dedupe ledger. A retried packet cannot recreate a deliberately purged kill as a fresh event.

For split deployments apply migrations before updating both roles (`bun run db:migrate`, then
restart web/worker with the same schema/configuration). The Timescale hypertable and its existing
timestamps remain intact. This change does not modify the bot, launch a moderation rule or
enable any previously disabled rule.
