package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"time"
)

func GenerateInviteCode() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	code := hex.EncodeToString(bytes)

	_, err := DB.Exec("INSERT INTO invites (code) VALUES (?)", code)
	if err != nil {
		return "", err
	}
	return code, nil
}

func ValidateAndUseInvite(code string, userID int64) error {
	result, err := DB.Exec(
		"UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL",
		userID, time.Now(), code,
	)
	if err != nil {
		return err
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func ValidateInvite(code string) error {
	var unused int
	return DB.QueryRow(
		"SELECT 1 FROM invites WHERE code = ? AND used_by IS NULL",
		code,
	).Scan(&unused)
}

func GetInviteStats() (total, used int, err error) {
	err = DB.QueryRow("SELECT COUNT(*) FROM invites").Scan(&total)
	if err != nil {
		return
	}
	err = DB.QueryRow("SELECT COUNT(*) FROM invites WHERE used_by IS NOT NULL").Scan(&used)
	return
}
