package api

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

const (
	webSocketTicketLifetime = 30 * time.Second
	maximumPendingTickets   = 10000
)

var errTooManyPendingTickets = errors.New("too many pending WebSocket tickets")

type webSocketTicket struct {
	UserID    int64
	Username  string
	ExpiresAt time.Time
}

type webSocketTicketStore struct {
	mu      sync.Mutex
	tickets map[string]webSocketTicket
}

func newWebSocketTicketStore() *webSocketTicketStore {
	return &webSocketTicketStore{tickets: make(map[string]webSocketTicket)}
}

func (s *webSocketTicketStore) issue(userID int64, username string, now time.Time) (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(bytes)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleteExpired(now)
	if len(s.tickets) >= maximumPendingTickets {
		return "", errTooManyPendingTickets
	}
	s.tickets[token] = webSocketTicket{
		UserID:    userID,
		Username:  username,
		ExpiresAt: now.Add(webSocketTicketLifetime),
	}
	return token, nil
}

func (s *webSocketTicketStore) consume(token string, now time.Time) (webSocketTicket, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ticket, ok := s.tickets[token]
	delete(s.tickets, token)
	if !ok || !ticket.ExpiresAt.After(now) {
		return webSocketTicket{}, false
	}
	return ticket, true
}

func (s *webSocketTicketStore) deleteExpired(now time.Time) {
	for token, ticket := range s.tickets {
		if !ticket.ExpiresAt.After(now) {
			delete(s.tickets, token)
		}
	}
}

var webSocketTickets = newWebSocketTicketStore()
