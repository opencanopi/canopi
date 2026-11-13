-- Frozen user DB 10 projection (Step 2.0.4 R2-2, canopi-f47t.52.271; 2.1-M480, A3).
--
-- What the reader release reads of a user DB 2.1 writes, as literal text: never regenerate, never edit a row. The
-- version is `PRAGMA user_version` and stays 10 or above; the reader opens it SQLITE_OPEN_READ_ONLY and reads the
-- v9 tables and columns by name. Later user DB steps may add tables and columns, never rename, retype or change
-- the meaning of these; R4's rollback lane holds them to that. A 2.1-only table and column stand in for what later
-- steps add, and two tables list their columns in another order, so a reader that reads by position fails here.

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE recent_files (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_opened TEXT NOT NULL,
    home_kind TEXT
);

CREATE TABLE favorites (
    added_at TEXT NOT NULL,
    canonical_name TEXT PRIMARY KEY
);

CREATE TABLE recently_viewed (
    canonical_name TEXT PRIMARY KEY,
    viewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER limit_recently_viewed
AFTER INSERT ON recently_viewed
BEGIN
    DELETE FROM recently_viewed WHERE canonical_name NOT IN (
        SELECT canonical_name FROM recently_viewed ORDER BY viewed_at DESC LIMIT 50
    );
END;

CREATE TABLE saved_object_stamps (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    name TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE design_notebook_entries (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    plant_count INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_opened TEXT NOT NULL
);

CREATE TABLE design_notebook_sections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE design_notebook_section_memberships (
    path TEXT PRIMARY KEY,
    section_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(path) REFERENCES design_notebook_entries(path) ON DELETE CASCADE,
    FOREIGN KEY(section_id) REFERENCES design_notebook_sections(id) ON DELETE CASCADE
);

CREATE TABLE session_last_home (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('settings', '{"locale":"de","theme":"dark"}');
INSERT INTO recent_files (path, name, last_opened, home_kind)
    VALUES ('/designs/orchard.canopi', 'Orchard', '2026-11-01T09:00:00Z', 'file');
INSERT INTO favorites (added_at, canonical_name) VALUES ('2026-11-01T09:00:00Z', 'Malus domestica');
INSERT INTO favorites (added_at, canonical_name) VALUES ('2026-11-02T09:00:00Z', 'Symphytum officinale');
INSERT INTO recently_viewed (canonical_name, viewed_at) VALUES ('Corylus avellana', '2026-11-03T09:00:00Z');
INSERT INTO saved_object_stamps (id, sort_order, name, payload_json, created_at, updated_at)
    VALUES ('stamp-hedge', 0, 'Hedge', '{"version":2,"plants":[],"zones":[],"annotations":[],"groups":[]}',
            '2026-11-01T09:00:00Z', '2026-11-01T09:00:00Z');
INSERT INTO design_notebook_entries (path, name, updated_at, plant_count, sort_order, created_at, last_opened)
    VALUES ('/designs/orchard.canopi', 'Orchard', '2026-11-01T09:00:00Z', 12, 0,
            '2026-11-01T09:00:00Z', '2026-11-01T09:00:00Z');
INSERT INTO design_notebook_sections (id, name, sort_order, created_at, updated_at)
    VALUES ('section-fruit', 'Fruit', 0, '2026-11-01T09:00:00Z', '2026-11-01T09:00:00Z');
INSERT INTO design_notebook_section_memberships (path, section_id, created_at, updated_at)
    VALUES ('/designs/orchard.canopi', 'section-fruit', '2026-11-01T09:00:00Z', '2026-11-01T09:00:00Z');
INSERT INTO session_last_home (key, value) VALUES ('home', 'file');

PRAGMA user_version = 10;
