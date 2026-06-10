-- Year-over-year equipment + sign-material counts transcribed from the DC33
-- "Sheet 6" counts tab. Physical end-of-con hardware stock (DC32=2024, DC33=2025)
-- and historical sign-material print totals (DC30=2022 .. DC32=2024). Idempotent
-- on (equipment_type_id, year). Run AFTER equipment-types.sql:
--   npx prisma db execute --file prisma/seeds/equipment-history.sql
INSERT INTO "equipment_inventory" ("equipment_type_id", "year", "count_end_of_con")
SELECT et."id", v."year", v."cnt"
FROM (
  VALUES
    -- DC33 (2025) physical end-of-con stock
    ('Tent Pole Easels',          2025, 114),
    ('Black Leg Tripod Easels',   2025, 68),
    ('Silver Tripod Easels',      2025, 7),
    ('U-Shaped Sock Stands',      2025, 7),
    ('Selfie Walls',              2025, 3),
    ('Sticker Wall Bases',        2025, 3),
    ('Screw Meterboards',         2025, 38),
    ('Bowtie Meterboards',        2025, 25),
    ('Spider-Foot Meterboards',   2025, 3),
    ('Railroad-Tie Meterboards',  2025, 7),
    ('CTF Selfie Banner',         2025, 1),
    -- DC32 (2024) physical end-of-con stock
    ('Tent Pole Easels',          2024, 71),
    ('Silver Tripod Easels',      2024, 22),
    ('Black Leg Tripod Easels',   2024, 67),
    ('Screw Meterboards',         2024, 38),
    ('Bowtie Meterboards',        2024, 25),
    ('Spider-Foot Meterboards',   2024, 7),
    ('Railroad-Tie Meterboards',  2024, 9),
    ('Cardboard Meterboards',     2024, 8),
    ('Selfie Banner Stands',      2024, 3),
    ('Sticker Wall Bases',        2024, 3),
    ('U-Shaped Sock Stands',      2024, 8),
    -- DC30 (2022) sign-material print totals
    ('Signs 22x28',               2022, 82),
    ('Signs 24x36',               2022, 49),
    ('Meterboard Signs (Single)', 2022, 50),
    ('Meterboard Signs (Double)', 2022, 12),
    ('Floor Graphics',            2022, 4),
    ('Easels Required',           2022, 131),
    -- DC31 (2023) sign-material print totals
    ('Signs 22x28',               2023, 68),
    ('Meterboard Signs (Single)', 2023, 49),
    ('Meterboard Signs (Double)', 2023, 0),
    ('Floor Graphics',            2023, 2),
    -- DC32 (2024) sign-material print totals
    ('Signs 22x28',               2024, 87),
    ('Signs 24x36',               2024, 39),
    ('Meterboard Signs (Single)', 2024, 14),
    ('Meterboard Signs (Double)', 2024, 71),
    ('Floor Graphics',            2024, 4),
    ('Easels Required',           2024, 126)
) AS v("name", "year", "cnt")
JOIN "equipment_types" et ON et."name" = v."name"
ON CONFLICT ("equipment_type_id", "year") DO UPDATE
  SET "count_end_of_con" = EXCLUDED."count_end_of_con";

-- Point-in-time qualifiers from the DC33 sheet (notes show in the per-year edit
-- view, not the YoY grid). Idempotent — re-asserts the note text.
UPDATE "equipment_inventory" SET "notes" = '2 out (on loan)'
WHERE "year" = 2025
  AND "equipment_type_id" = (SELECT "id" FROM "equipment_types" WHERE "name" = 'Silver Tripod Easels');
UPDATE "equipment_inventory" SET "notes" = 'plus several extra poles (incomplete sets)'
WHERE "year" = 2025
  AND "equipment_type_id" = (SELECT "id" FROM "equipment_types" WHERE "name" = 'Selfie Walls');
