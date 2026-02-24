package db

import (
	"database/sql"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

var DB *sql.DB

type User struct {
	ID           int64     `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"` // never expose in JSON
	PublicKey    []byte    `json:"public_key"`
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
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}

	db.SetMaxOpenConns(1) // SQLite requires this for WAL mode with multiple goroutines
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(time.Hour)

	if err := db.Ping(); err != nil {
		return nil, err
	}

	if err := migrate(db); err != nil {
		return nil, err
	}

	DB = db
	return db, nil
}

func migrate(db *sql.DB) error {
	schema := `
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
		status TEXT DEFAULT 'pending', -- pending, active, ended, rejected
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		ended_at DATETIME,
		FOREIGN KEY (caller_id) REFERENCES users(id),
		FOREIGN KEY (callee_id) REFERENCES users(id)
	);
	`

	_, err := db.Exec(schema)
	return err
}
