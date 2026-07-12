package db

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
)

var ErrIdempotencyConflict = errors.New("message idempotency key already used with different content")

func SaveMessage(senderID, receiverID int64, clientID, msgType string, content, nonce []byte) (*Message, bool, error) {
	result, err := DB.Exec(
		`INSERT OR IGNORE INTO messages (sender_id, receiver_id, client_id, type, content, nonce)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		senderID, receiverID, clientID, msgType, content, nonce,
	)
	if err != nil {
		return nil, false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return nil, false, err
	}
	if rows == 1 {
		id, err := result.LastInsertId()
		if err != nil {
			return nil, false, err
		}
		message, err := GetMessageByID(id)
		return message, true, err
	}

	message, err := GetMessageByClientID(senderID, clientID)
	if err != nil {
		return nil, false, err
	}
	if message == nil || message.ReceiverID != receiverID || message.Type != msgType ||
		!bytes.Equal(message.Content, content) || !bytes.Equal(message.Nonce, nonce) {
		return nil, false, ErrIdempotencyConflict
	}
	return message, false, nil
}

func GetMessageByID(id int64) (*Message, error) {
	var msg Message
	err := DB.QueryRow(
		"SELECT id, sender_id, receiver_id, type, content, nonce, COALESCE(client_id, ''), timestamp, read FROM messages WHERE id = ?",
		id,
	).Scan(&msg.ID, &msg.SenderID, &msg.ReceiverID, &msg.Type, &msg.Content, &msg.Nonce, &msg.ClientID, &msg.Timestamp, &msg.Read)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &msg, nil
}

func GetMessageByClientID(senderID int64, clientID string) (*Message, error) {
	var msg Message
	err := DB.QueryRow(
		`SELECT id, sender_id, receiver_id, type, content, nonce, COALESCE(client_id, ''), timestamp, read
		 FROM messages WHERE sender_id = ? AND client_id = ?`,
		senderID, clientID,
	).Scan(&msg.ID, &msg.SenderID, &msg.ReceiverID, &msg.Type, &msg.Content, &msg.Nonce, &msg.ClientID, &msg.Timestamp, &msg.Read)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &msg, nil
}

func GetMessagesBetween(userID1, userID2 int64, limit int, beforeID int64) ([]Message, error) {
	rows, err := DB.Query(
		`SELECT id, sender_id, receiver_id, type, content, nonce, COALESCE(client_id, ''), timestamp, read 
		 FROM messages 
		 WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
		   AND (? = 0 OR id < ?)
		   AND id > COALESCE((
		     SELECT through_id FROM conversation_clears WHERE user_id = ? AND other_user_id = ?
		   ), 0)
		 ORDER BY id DESC
		 LIMIT ?`,
		userID1, userID2, userID2, userID1, beforeID, beforeID, userID1, userID2, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Initialize as empty slice, not nil
	messages := make([]Message, 0)
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.SenderID, &m.ReceiverID, &m.Type, &m.Content, &m.Nonce, &m.ClientID, &m.Timestamp, &m.Read); err != nil {
			return nil, err
		}
		messages = append(messages, m)
	}
	return messages, rows.Err()
}

func GetUnreadMessagesForUser(userID int64) ([]Message, error) {
	rows, err := DB.Query(
		`SELECT id, sender_id, receiver_id, type, content, nonce, COALESCE(client_id, ''), timestamp, read 
		 FROM messages 
		 WHERE receiver_id = ? AND read = FALSE
		 ORDER BY timestamp ASC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	messages := make([]Message, 0)
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.SenderID, &m.ReceiverID, &m.Type, &m.Content, &m.Nonce, &m.ClientID, &m.Timestamp, &m.Read); err != nil {
			return nil, err
		}
		messages = append(messages, m)
	}
	return messages, rows.Err()
}

func MarkMessagesAsReadRange(senderID, receiverID, fromID, throughID int64) (int64, error) {
	result, err := DB.Exec(
		`UPDATE messages SET read = TRUE
		 WHERE sender_id = ? AND receiver_id = ? AND read = FALSE AND id BETWEEN ? AND ?`,
		senderID, receiverID, fromID, throughID,
	)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func ClearMessagesForUser(ctx context.Context, userID, otherUserID int64) (int64, error) {
	tx, err := DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var throughID int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(id), 0) FROM messages
		 WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)`,
		userID, otherUserID, otherUserID, userID,
	).Scan(&throughID); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO conversation_clears (user_id, other_user_id, through_id, cleared_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, other_user_id) DO UPDATE SET
			through_id = MAX(conversation_clears.through_id, excluded.through_id),
			cleared_at = CURRENT_TIMESTAMP
	`, userID, otherUserID, throughID); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return throughID, nil
}
