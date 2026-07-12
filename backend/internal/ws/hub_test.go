package ws

import (
	"encoding/json"
	"testing"
	"time"
)

func TestHubSupportsMultipleSessionsPerUser(t *testing.T) {
	hub := NewHub()
	hub.Run()
	first := &Client{Hub: hub, Send: make(chan []byte, 4), UserID: 42, Username: "alice"}
	second := &Client{Hub: hub, Send: make(chan []byte, 4), UserID: 42, Username: "alice"}
	if !hub.RegisterClient(first) || !hub.RegisterClient(second) {
		t.Fatal("failed to register client sessions")
	}
	waitFor(t, func() bool {
		hub.mu.RLock()
		defer hub.mu.RUnlock()
		return len(hub.Clients[42]) == 2
	})

	hub.SendMessage(42, Message{Type: "message", ID: 99, From: 7})
	for index, client := range []*Client{first, second} {
		select {
		case payload := <-client.Send:
			var message Message
			if err := json.Unmarshal(payload, &message); err != nil {
				t.Fatal(err)
			}
			if message.ID != 99 {
				t.Fatalf("session %d received message ID %d", index, message.ID)
			}
		case <-time.After(time.Second):
			t.Fatalf("session %d did not receive message", index)
		}
	}

	hub.unregister <- first
	waitFor(t, func() bool {
		hub.mu.RLock()
		defer hub.mu.RUnlock()
		return len(hub.Clients[42]) == 1
	})
	if !hub.IsOnline(42) {
		t.Fatal("user went offline while another session remained")
	}

	hub.Shutdown()
	if hub.IsOnline(42) {
		t.Fatal("user remained online after hub shutdown")
	}
	if hub.RegisterClient(&Client{Send: make(chan []byte, 1), UserID: 7}) {
		t.Fatal("hub accepted a client after shutdown")
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition was not met before timeout")
		}
		time.Sleep(time.Millisecond)
	}
}
