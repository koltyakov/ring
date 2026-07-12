package db

import (
	"database/sql"
)

func SaveMessage(senderID, receiverID int64, msgType string, content, nonce []byte) (*Message, error) {
	result, err := DB.Exec(
		"INSERT INTO messages (sender_id, receiver_id, type, content, nonce) VALUES (?, ?, ?, ?, ?)",
		senderID, receiverID, msgType, content, nonce,
	)
	if err != nil {
		return nil, err
	}

	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	return GetMessageByID(id)
}

func GetMessageByID(id int64) (*Message, error) {
	var msg Message
	err := DB.QueryRow(
		"SELECT id, sender_id, receiver_id, type, content, nonce, timestamp, read FROM messages WHERE id = ?",
		id,
	).Scan(&msg.ID, &msg.SenderID, &msg.ReceiverID, &msg.Type, &msg.Content, &msg.Nonce, &msg.Timestamp, &msg.Read)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &msg, nil
}

func GetMessagesBetween(userID1, userID2 int64, limit int, beforeID int64) ([]Message, error) {
	rows, err := DB.Query(
		`SELECT id, sender_id, receiver_id, type, content, nonce, timestamp, read 
		 FROM messages 
		 WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
		   AND (? = 0 OR id < ?)
		 ORDER BY id DESC
		 LIMIT ?`,
		userID1, userID2, userID2, userID1, beforeID, beforeID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Initialize as empty slice, not nil
	messages := make([]Message, 0)
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.SenderID, &m.ReceiverID, &m.Type, &m.Content, &m.Nonce, &m.Timestamp, &m.Read); err != nil {
			return nil, err
		}
		messages = append(messages, m)
	}
	return messages, rows.Err()
}

func GetUnreadMessagesForUser(userID int64) ([]Message, error) {
	rows, err := DB.Query(
		`SELECT id, sender_id, receiver_id, type, content, nonce, timestamp, read 
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
		if err := rows.Scan(&m.ID, &m.SenderID, &m.ReceiverID, &m.Type, &m.Content, &m.Nonce, &m.Timestamp, &m.Read); err != nil {
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

func DeleteMessagesBetween(userID1, userID2 int64) error {
	_, err := DB.Exec(
		"DELETE FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)",
		userID1, userID2, userID2, userID1,
	)
	return err
}
