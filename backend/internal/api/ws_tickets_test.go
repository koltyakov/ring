package api

import (
	"testing"
	"time"
)

func TestWebSocketTicketIsSingleUse(t *testing.T) {
	store := newWebSocketTicketStore()
	now := time.Date(2026, time.July, 12, 12, 0, 0, 0, time.UTC)
	token, err := store.issue(42, "alice", now)
	if err != nil {
		t.Fatal(err)
	}

	ticket, ok := store.consume(token, now.Add(time.Second))
	if !ok || ticket.UserID != 42 || ticket.Username != "alice" {
		t.Fatalf("unexpected ticket: %+v, valid=%t", ticket, ok)
	}
	if _, ok := store.consume(token, now.Add(2*time.Second)); ok {
		t.Fatal("ticket was accepted more than once")
	}
}

func TestWebSocketTicketExpires(t *testing.T) {
	store := newWebSocketTicketStore()
	now := time.Date(2026, time.July, 12, 12, 0, 0, 0, time.UTC)
	token, err := store.issue(42, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := store.consume(token, now.Add(webSocketTicketLifetime)); ok {
		t.Fatal("expired ticket was accepted")
	}
}
