package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

var DB *sql.DB

type User struct {
	ID           int64     `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"` // never expose in JSON
	PublicKey    []byte    `json:"public_key"`
	AuthVersion  int64     `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
	LastSeen     time.Time `json:"last_seen"`
}

type Message struct {
	ID         int64     `json:"id"`
	SenderID   int64     `json:"sender_id"`
	ReceiverID int64     `json:"receiver_id"`
	Type       string    `json:"type"`    // text, file, call
	Content    []byte    `json:"content"` // encrypted content
	Nonce      []byte    `json:"nonce"`
	Timestamp  time.Time `json:"timestamp"`
	Read       bool      `json:"read"`
}

type Invite struct {
	ID        int64      `json:"id"`
	Code      string     `json:"code"`
	UsedBy    *int64     `json:"used_by"`
	CreatedAt time.Time  `json:"created_at"`
	UsedAt    *time.Time `json:"used_at"`
}

func InitDB(dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on&_txlock=immediate")
	if err != nil {
		return nil, err
	}

	db.SetMaxOpenConns(1) // Serialize transactions and writes through one connection.
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(time.Hour)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}

	DB = db
	return db, nil
}

type migration struct {
	version    int
	statements []string
}

var migrations = []migration{
	{
		version: 1,
		statements: []string{`
			CREATE TABLE IF NOT EXISTS users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				username TEXT UNIQUE NOT NULL,
				password_hash TEXT NOT NULL,
				public_key BLOB NOT NULL,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				sender_id INTEGER NOT NULL,
				receiver_id INTEGER NOT NULL,
				type TEXT DEFAULT 'text',
				content BLOB NOT NULL,
				nonce BLOB NOT NULL,
				timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
				read BOOLEAN DEFAULT FALSE,
				FOREIGN KEY (sender_id) REFERENCES users(id),
				FOREIGN KEY (receiver_id) REFERENCES users(id)
			);

			CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
			CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
			CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

			CREATE TABLE IF NOT EXISTS invites (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				code TEXT UNIQUE NOT NULL,
				used_by INTEGER,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				used_at DATETIME,
				FOREIGN KEY (used_by) REFERENCES users(id)
			);

			CREATE TABLE IF NOT EXISTS call_sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				caller_id INTEGER NOT NULL,
				callee_id INTEGER NOT NULL,
				session_id TEXT UNIQUE NOT NULL,
				status TEXT DEFAULT 'pending',
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				ended_at DATETIME,
				FOREIGN KEY (caller_id) REFERENCES users(id),
				FOREIGN KEY (callee_id) REFERENCES users(id)
			);
		`},
	},
	{
		version: 2,
		statements: []string{
			`CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver_id ON messages(sender_id, receiver_id, id DESC)`,
			`CREATE INDEX IF NOT EXISTS idx_messages_receiver_sender_id ON messages(receiver_id, sender_id, id DESC)`,
			`CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, read, id)`,
		},
	},
	{
		version: 3,
		statements: []string{
			`ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0`,
		},
	},
}

func migrate(db *sql.DB) error {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}

	rows, err := db.Query("SELECT version FROM schema_migrations ORDER BY version")
	if err != nil {
		return fmt.Errorf("read migration versions: %w", err)
	}
	var applied []int
	for rows.Next() {
		var version int
		if err := rows.Scan(&version); err != nil {
			rows.Close()
			return fmt.Errorf("scan migration version: %w", err)
		}
		applied = append(applied, version)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close migration rows: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate migration versions: %w", err)
	}

	for index, version := range applied {
		expected := index + 1
		if version != expected {
			return fmt.Errorf("invalid migration history: expected version %d, found %d", expected, version)
		}
	}
	if len(applied) > len(migrations) {
		return fmt.Errorf("database schema version %d is newer than supported version %d", applied[len(applied)-1], len(migrations))
	}

	for _, migration := range migrations[len(applied):] {
		if migration.version != len(applied)+1 {
			return fmt.Errorf("invalid migration definition: expected version %d, found %d", len(applied)+1, migration.version)
		}
		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("begin migration %d: %w", migration.version, err)
		}
		for _, statement := range migration.statements {
			if _, err := tx.Exec(statement); err != nil {
				tx.Rollback()
				return fmt.Errorf("apply migration %d: %w", migration.version, err)
			}
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations (version) VALUES (?)", migration.version); err != nil {
			tx.Rollback()
			return fmt.Errorf("record migration %d: %w", migration.version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %d: %w", migration.version, err)
		}
		applied = append(applied, migration.version)
	}
	return nil
}
