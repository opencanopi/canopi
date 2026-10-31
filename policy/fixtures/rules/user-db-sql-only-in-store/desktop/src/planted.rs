// The planted user-db-sql-only-in-store violation: a site in a file its family does not list.
fn f(c: &Connection) { c.execute_batch("PRAGMA foreign_keys = ON"); }
