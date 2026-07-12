package db

import (
	"context"
	"errors"
	"fmt"
	"sync"
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
		if _, _, err := SaveMessage(alice.ID, bob.ID, fmt.Sprintf("client-message-%d", i), "text", []byte(fmt.Sprintf("message-%d", i)), make([]byte, 12)); err != nil {
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

func TestSaveMessageIsIdempotent(t *testing.T) {
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

	first, created, err := SaveMessage(alice.ID, bob.ID, "client-message-1", "text", []byte("ciphertext"), make([]byte, 12))
	if err != nil || !created {
		t.Fatalf("first save: created=%t err=%v", created, err)
	}
	duplicate, created, err := SaveMessage(alice.ID, bob.ID, "client-message-1", "text", []byte("ciphertext"), make([]byte, 12))
	if err != nil || created {
		t.Fatalf("duplicate save: created=%t err=%v", created, err)
	}
	if duplicate.ID != first.ID {
		t.Fatalf("duplicate returned ID %d, expected %d", duplicate.ID, first.ID)
	}
	if _, _, err := SaveMessage(alice.ID, bob.ID, "client-message-1", "text", []byte("different"), make([]byte, 12)); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected ErrIdempotencyConflict, got %v", err)
	}

	const attempts = 8
	results := make(chan bool, attempts)
	errs := make(chan error, attempts)
	var wg sync.WaitGroup
	for range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, created, err := SaveMessage(alice.ID, bob.ID, "concurrent-message-id", "text", []byte("ciphertext"), make([]byte, 12))
			results <- created
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	createdCount := 0
	for created := range results {
		if created {
			createdCount++
		}
	}
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if createdCount != 1 {
		t.Fatalf("expected one created message, got %d", createdCount)
	}
}
