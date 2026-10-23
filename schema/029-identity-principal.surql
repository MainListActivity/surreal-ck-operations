-- v29: registered identity principals (SYS-DISP IR01/IR02/Q3). Additive only: no existing row is rewritten.
-- A principal is the explicit, manage-controlled link that makes two employeeIds one person for independence purposes.
-- `employee.principal` is the only identity key an independence policy reads besides the employeeId itself: a definition is a
-- capacity template, never an identity, so two independent employees of one definition stay independent until a manager
-- registers a principal here. Every write is compare-and-set, audited, and refuses while the employee holds a live lease.
DEFINE TABLE IF NOT EXISTS principal SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS reason ON principal TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS employees ON principal TYPE option<array<record<employee>>>;
DEFINE FIELD IF NOT EXISTS created_at ON principal TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS principal ON employee TYPE option<record<principal>>;
