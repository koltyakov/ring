package db

import (
	"context"
	"fmt"
	"testing"
)

func TestMessageCursorPaginationAndReadRange(t *testing.T) {
	initTestDB(t)
	ctx := context.Background()
	publicKey := make([]byte, 32)
	alice, err := RegisterUser(ctx, "alice", "hash", publicKey, "", true)
	if err != nil {
		t.Fatal(err)
	}
	code, err := GenerateInviteCode()
	if err != nil {
		t.Fatal(err)
	}
	bob, err := RegisterUser(ctx, "bob", "hash", publicKey, code, false)
	if err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 12; i++ {
		if _, err := SaveMessage(alice.ID, bob.ID, "text", []byte(fmt.Sprintf("message-%d", i)), make([]byte, 12)); err != nil {
			t.Fatal(err)
		}
	}

	firstPage, err := GetMessagesBetween(alice.ID, bob.ID, 5, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstPage) != 5 || firstPage[0].ID <= firstPage[4].ID {
		t.Fatalf("unexpected first page: %+v", firstPage)
	}
	secondPage, err := GetMessagesBetween(alice.ID, bob.ID, 5, firstPage[4].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(secondPage) != 5 || secondPage[0].ID >= firstPage[4].ID {
		t.Fatalf("unexpected second page: %+v", secondPage)
	}

	updated, err := MarkMessagesAsReadRange(alice.ID, bob.ID, firstPage[4].ID, firstPage[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated != 5 {
		t.Fatalf("expected 5 messages marked read, got %d", updated)
	}

	remaining, err := GetUnreadMessagesForUser(bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 7 {
		t.Fatalf("expected 7 unread messages, got %d", len(remaining))
	}
}
