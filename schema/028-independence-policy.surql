-- v28: independence policy (SYS-DISP IR01-IR03). Additive only: legacy task rows stay as they are and mean "no policy".
-- `independence` is written only by the manager path (setIndependence: compare-and-set on version, audited) and is read in the same
-- transaction as the contribution facts. `independence_guard` is the source-side half of a dependent's version guard: a lease write
-- that read a source at some version writes this field on that source, so a concurrent authorship change on the source conflicts
-- with it instead of slipping between the read and the write.
DEFINE FIELD IF NOT EXISTS independence ON task TYPE option<object>;
DEFINE FIELD IF NOT EXISTS independence_guard ON task TYPE option<int>;
