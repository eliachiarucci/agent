-- Devices keep their whole settings from when they were created: those still on
-- the old 300 ms end of turn move to the new default, 700 ms (plan rev 19).
UPDATE "devices"
SET "settings" = jsonb_set("settings", '{voice,endOfTurnMs}', '700')
WHERE "settings" #>> '{voice,endOfTurnMs}' = '300';
