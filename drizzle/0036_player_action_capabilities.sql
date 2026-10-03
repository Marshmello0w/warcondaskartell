-- 'Kick, kill, move' (players.moderate) is split in three: 'Kick' (players.kick), 'Kill'
-- (players.kill) and 'Move' (players.move). Every role and every API key that held it holds all
-- three, so nobody's access changes. They are capabilities on a server, so a key limited to some
-- servers keeps them there.
UPDATE "org_roles"
   SET "capabilities" = ("capabilities" - 'players.moderate')
       || '["players.kick","players.kill","players.move"]'::jsonb
 WHERE "capabilities" @> '["players.moderate"]'::jsonb;
--> statement-breakpoint
UPDATE "api_keys"
   SET "capabilities" = ("capabilities" - 'players.moderate')
       || '["players.kick","players.kill","players.move"]'::jsonb
 WHERE "capabilities" @> '["players.moderate"]'::jsonb;
