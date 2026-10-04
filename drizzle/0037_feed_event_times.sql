CREATE TABLE "feed_clocks" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"source_id" text NOT NULL,
	"map" text NOT NULL,
	"match_row" bigint,
	"first_receipt_at" timestamp with time zone NOT NULL,
	"last_receipt_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"anchor_at" timestamp with time zone,
	"max_event_time" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_events" (
	"server_id" text NOT NULL,
	"event_id" text NOT NULL,
	"first_received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feed_events_server_id_event_id_pk" PRIMARY KEY("server_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN "packet_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN "warcon_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN "source_received_at" text;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN "relay_source_id" text;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN "event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN "time_quality" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN "clock_id" text;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN "historical" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN "moderation_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "feed_clocks_server_idx" ON "feed_clocks" USING btree ("server_id","last_receipt_at");
--> statement-breakpoint
-- Preserve every existing event id without changing any old kill timestamp or round assignment.
-- Install the trigger under the same lock as the backfill, including writes by an older web
-- process during deployment. New ingest claims the key itself in its atomic transaction.
LOCK TABLE kills IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO feed_events (server_id, event_id, first_received_at)
SELECT server_id, event_id, MIN(ts) FROM kills GROUP BY server_id, event_id
ON CONFLICT (server_id, event_id) DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION remember_feed_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO feed_events (server_id, event_id, first_received_at)
  VALUES (NEW.server_id, NEW.event_id, COALESCE(NEW.warcon_received_at, NEW.ts))
  ON CONFLICT (server_id, event_id) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER remember_feed_event AFTER INSERT ON kills
FOR EACH ROW EXECUTE FUNCTION remember_feed_event();
