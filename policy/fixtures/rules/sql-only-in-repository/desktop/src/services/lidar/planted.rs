// The planted sql-only-in-repository violation: a site in a file its family does not list.
fn f(c: &Connection) { c.execute("UPDATE lidar_items SET state = ?1", []); }
