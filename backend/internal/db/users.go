package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/mattn/go-sqlite3"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInviteRequired = errors.New("invite code required")
	ErrInvalidInvite  = errors.New("invalid or used invite code")
	ErrUsernameExists = errors.New("username already exists")
)

// HashPassword hashes a password using bcrypt
func HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(bytes), err
}

// CheckPassword compares a password with a hash
func CheckPassword(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

func CreateUser(username string, passwordHash string, publicKey []byte) (*User, error) {
	result, err := DB.Exec(
		"INSERT INTO users (username, password_hash, public_key) VALUES (?, ?, ?)",
		username, passwordHash, publicKey,
	)
	if err != nil {
		return nil, err
	}

	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	return GetUserByID(id)
}

// RegisterUser atomically creates a user and consumes the required invite.
func RegisterUser(ctx context.Context, username, passwordHash string, publicKey []byte, inviteCode string) (*User, error) {
	tx, err := DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var userCount int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM users").Scan(&userCount); err != nil {
		return nil, err
	}

	requiresInvite := userCount > 0
	if requiresInvite && inviteCode == "" {
		return nil, ErrInviteRequired
	}

	result, err := tx.ExecContext(ctx,
		"INSERT INTO users (username, password_hash, public_key) VALUES (?, ?, ?)",
		username, passwordHash, publicKey,
	)
	if err != nil {
		var sqliteErr sqlite3.Error
		if errors.As(err, &sqliteErr) && sqliteErr.ExtendedCode == sqlite3.ErrConstraintUnique {
			return nil, ErrUsernameExists
		}
		return nil, err
	}

	userID, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}

	if requiresInvite {
		result, err = tx.ExecContext(ctx,
			"UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL",
			userID, time.Now(), inviteCode,
		)
		if err != nil {
			return nil, err
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return nil, err
		}
		if rows != 1 {
			return nil, ErrInvalidInvite
		}
	}

	var user User
	if err := tx.QueryRowContext(ctx,
		"SELECT id, username, public_key, created_at, last_seen FROM users WHERE id = ?",
		userID,
	).Scan(&user.ID, &user.Username, &user.PublicKey, &user.CreatedAt, &user.LastSeen); err != nil {
		return nil, fmt.Errorf("load registered user: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &user, nil
}

func GetUserByID(id int64) (*User, error) {
	var user User
	err := DB.QueryRow(
		"SELECT id, username, public_key, created_at, last_seen FROM users WHERE id = ?",
		id,
	).Scan(&user.ID, &user.Username, &user.PublicKey, &user.CreatedAt, &user.LastSeen)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

// GetUserByUsername gets user without password (for public info)
func GetUserByUsername(username string) (*User, error) {
	var user User
	err := DB.QueryRow(
		"SELECT id, username, public_key, created_at, last_seen FROM users WHERE username = ?",
		username,
	).Scan(&user.ID, &user.Username, &user.PublicKey, &user.CreatedAt, &user.LastSeen)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

// GetUserByUsernameWithPassword gets user with password hash (for login)
func GetUserByUsernameWithPassword(username string) (*User, error) {
	var user User
	err := DB.QueryRow(
		"SELECT id, username, password_hash, public_key, created_at, last_seen FROM users WHERE username = ?",
		username,
	).Scan(&user.ID, &user.Username, &user.PasswordHash, &user.PublicKey, &user.CreatedAt, &user.LastSeen)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func GetAllUsers() ([]User, error) {
	rows, err := DB.Query(
		"SELECT id, username, public_key, created_at, last_seen FROM users ORDER BY username",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	users := make([]User, 0)
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.PublicKey, &u.CreatedAt, &u.LastSeen); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func UpdateLastSeen(userID int64) error {
	_, err := DB.Exec("UPDATE users SET last_seen = ? WHERE id = ?", time.Now(), userID)
	return err
}

func UpdatePublicKey(userID int64, publicKey []byte) error {
	_, err := DB.Exec("UPDATE users SET public_key = ? WHERE id = ?", publicKey, userID)
	return err
}
