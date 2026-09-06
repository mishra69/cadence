-- A second scheduled push, for the morning marker.
--
-- §0 says one scheduled push per day, and this is a departure. The reason that
-- rule exists is that asking about the *behaviour* is itself a cue — that is
-- what killed the randomized probes in Appendix A. This asks about a
-- physiological marker instead, so it does not trip the mechanism the rule was
-- protecting. The justification is measurement: asked at 21:00 the honest
-- answer is "don't recall" every day, and a reading taken at the wrong time is
-- worse than no reading.
ALTER TABLE settings ADD COLUMN morning_checkin_hour INTEGER DEFAULT 10;
ALTER TABLE settings ADD COLUMN morning_checkin_enabled INTEGER DEFAULT 1;
