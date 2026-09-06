-- A physiological marker recorded on the daily check-in rather than as its own
-- event kind: it is a property OF the day, not something that happens at a
-- moment, and giving it a timestamp would invite a precision nobody has.
--
-- NULL means "not answered", which must stay distinguishable from 0.
ALTER TABLE events ADD COLUMN morning_wood INTEGER;
