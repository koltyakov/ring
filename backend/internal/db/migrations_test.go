package db

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func TestMigrationsRecordVersionsAndIndexes(t *testing.T) {
	initTestDB(t)

	var count int
	if err := DB.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != len(migrations) {
		t.Fatalf("expected %d migrations, got %d", len(migrations), count)
	}

	for _, index := range []string{
		"idx_messages_sender_receiver_id",
		"idx_messages_receiver_sender_id",
		"idx_messages_unread",
	} {
		var found string
		if err := DB.QueryRow("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", index).Scan(&found); err != nil {
			t.Errorf("missing index %s: %v", index, err)
		}
	}
}

func TestMigrationsAdoptExistingDatabase(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			public_key BLOB NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		INSERT INTO users (username, password_hash, public_key) VALUES ('legacy', 'hash', X'00');
	`); err != nil {
		legacy.Close()
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	database, err := InitDB(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		database.Close()
		DB = nil
	})

	var count int
	if err := database.QueryRow("SELECT COUNT(*) FROM users WHERE username = 'legacy'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected legacy user to be preserved, got %d", count)
	}
}

func TestMigrationsRejectUnknownHistory(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "future.db")
	database, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
		CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME);
		INSERT INTO schema_migrations (version, applied_at) VALUES (999, CURRENT_TIMESTAMP);
	`); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	if database, err := InitDB(dbPath); err == nil {
		database.Close()
		t.Fatal("database with unknown migration history was accepted")
	}
}
