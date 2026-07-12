package api

import (
	"chatapp/internal/auth"
	"chatapp/internal/db"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestPasswordResetRevokesExistingToken(t *testing.T) {
	database, err := db.InitDB(filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		database.Close()
		db.DB = nil
	})
	if err := auth.Configure("0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}

	user, err := db.RegisterUser(context.Background(), "alice", "old-hash", make([]byte, 32), "", true)
	if err != nil {
		t.Fatal(err)
	}
	oldToken, err := auth.GenerateToken(user.ID, user.Username, user.AuthVersion)
	if err != nil {
		t.Fatal(err)
	}
	handler := authMiddleware(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	request := httptest.NewRequest(http.MethodGet, "/protected", nil)
	request.Header.Set("Authorization", "Bearer "+oldToken)
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("new token was rejected with status %d", recorder.Code)
	}

	if err := db.UpdatePasswordHash(user.ID, "new-hash"); err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	handler(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("old token was not revoked; status %d", recorder.Code)
	}

	updated, err := db.GetUserByID(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	newToken, err := auth.GenerateToken(updated.ID, updated.Username, updated.AuthVersion)
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, "/protected", nil)
	request.Header.Set("Authorization", "Bearer "+newToken)
	recorder = httptest.NewRecorder()
	handler(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("replacement token was rejected with status %d", recorder.Code)
	}
}
