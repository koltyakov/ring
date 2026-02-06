package db

import (
	"database/sql"
	"time"

	"golang.org/x/crypto/bcrypt"
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

	id, _ := result.LastInsertId()
	return GetUserByID(id)
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
