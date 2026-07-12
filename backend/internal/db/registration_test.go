package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

func initTestDB(t *testing.T) {
	t.Helper()
	database, err := InitDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		database.Close()
		DB = nil
	})
}

func TestRegisterUserRequiresAndConsumesInvite(t *testing.T) {
	initTestDB(t)
	ctx := context.Background()
	publicKey := make([]byte, 32)

	if _, err := RegisterUser(ctx, "first", "hash", publicKey, ""); err != nil {
		t.Fatalf("register first user: %v", err)
	}
	if _, err := RegisterUser(ctx, "second", "hash", publicKey, ""); !errors.Is(err, ErrInviteRequired) {
		t.Fatalf("expected ErrInviteRequired, got %v", err)
	}

	code, err := GenerateInviteCode()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RegisterUser(ctx, "second", "hash", publicKey, code); err != nil {
		t.Fatalf("register invited user: %v", err)
	}
	if err := ValidateInvite(code); err == nil {
		t.Fatal("consumed invite still validates")
	}
}

func TestRegisterUserAllowsOnlyOneConcurrentFirstUser(t *testing.T) {
	initTestDB(t)
	ctx := context.Background()
	publicKey := make([]byte, 32)

	const attempts = 8
	results := make(chan error, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := RegisterUser(ctx, fmt.Sprintf("first-%d", i), "hash", publicKey, "")
			results <- err
		}(i)
	}
	wg.Wait()
	close(results)

	successes := 0
	for err := range results {
		if err == nil {
			successes++
			continue
		}
		if !errors.Is(err, ErrInviteRequired) {
			t.Errorf("unexpected registration error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("expected one first user, got %d", successes)
	}
}

func TestRegisterUserAllowsOnlyOneConcurrentInviteClaim(t *testing.T) {
	initTestDB(t)
	ctx := context.Background()
	publicKey := make([]byte, 32)
	if _, err := RegisterUser(ctx, "first", "hash", publicKey, ""); err != nil {
		t.Fatal(err)
	}
	code, err := GenerateInviteCode()
	if err != nil {
		t.Fatal(err)
	}

	const attempts = 8
	results := make(chan error, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := RegisterUser(ctx, fmt.Sprintf("user-%d", i), "hash", publicKey, code)
			results <- err
		}(i)
	}
	wg.Wait()
	close(results)

	successes := 0
	for err := range results {
		if err == nil {
			successes++
			continue
		}
		if !errors.Is(err, ErrInvalidInvite) {
			t.Errorf("unexpected registration error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("expected one successful invite claim, got %d", successes)
	}
}

func TestForeignKeysAreEnforced(t *testing.T) {
	initTestDB(t)
	if _, err := SaveMessage(100, 200, "text", []byte("ciphertext"), make([]byte, 12)); err == nil {
		t.Fatal("message with nonexistent users was accepted")
	}
}

func TestUpdatePasswordHashRequiresExistingUser(t *testing.T) {
	initTestDB(t)
	user, err := RegisterUser(context.Background(), "alice", "old-hash", make([]byte, 32), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdatePasswordHash(user.ID, "new-hash"); err != nil {
		t.Fatal(err)
	}
	updated, err := GetUserByUsernameWithPassword("alice")
	if err != nil {
		t.Fatal(err)
	}
	if updated.PasswordHash != "new-hash" {
		t.Fatalf("password hash was not updated: %q", updated.PasswordHash)
	}
	if err := UpdatePasswordHash(999, "hash"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected sql.ErrNoRows, got %v", err)
	}
}
