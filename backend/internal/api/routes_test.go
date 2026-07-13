package api

import (
	"chatapp/internal/db"
	"context"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSPAFileHandler(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("app shell"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staticDir, "app.js"), []byte("javascript"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := spaFileHandler(staticDir)

	tests := []struct {
		path       string
		statusCode int
		body       string
	}{
		{path: "/chat/42", statusCode: http.StatusOK, body: "app shell"},
		{path: "/app.js", statusCode: http.StatusOK, body: "javascript"},
		{path: "/missing.js", statusCode: http.StatusNotFound},
		{path: "/api/unknown", statusCode: http.StatusNotFound},
	}

	for _, test := range tests {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, test.path, nil))
		if recorder.Code != test.statusCode {
			t.Errorf("%s: expected status %d, got %d", test.path, test.statusCode, recorder.Code)
		}
		if test.body != "" && recorder.Body.String() != test.body {
			t.Errorf("%s: expected body %q, got %q", test.path, test.body, recorder.Body.String())
		}
	}
}

func TestDecodeJSONRejectsUnknownTrailingAndOversizedInput(t *testing.T) {
	tests := []struct {
		name  string
		body  string
		limit int64
	}{
		{name: "unknown field", body: `{"name":"alice","admin":true}`, limit: 1024},
		{name: "trailing object", body: `{"name":"alice"} {}`, limit: 1024},
		{name: "oversized", body: `{"name":"alice"}`, limit: 4},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			var destination struct {
				Name string `json:"name"`
			}
			if err := decodeJSON(recorder, request, &destination, test.limit); err == nil {
				t.Fatal("expected JSON decoding to fail")
			}
		})
	}
}

func TestDecodeJSONRequiresJSONContentType(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		wantError   bool
	}{
		{name: "missing", wantError: true},
		{name: "plain text", contentType: "text/plain", wantError: true},
		{name: "json", contentType: "application/json", wantError: false},
		{name: "json with charset", contentType: "application/json; charset=utf-8", wantError: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"alice"}`))
			request.Header.Set("Content-Type", test.contentType)
			var destination struct {
				Name string `json:"name"`
			}
			err := decodeJSON(httptest.NewRecorder(), request, &destination, 1024)
			if (err != nil) != test.wantError {
				t.Fatalf("decodeJSON() error = %v, wantError %t", err, test.wantError)
			}
		})
	}
}

func TestValidPublicKey(t *testing.T) {
	validP256 := elliptic.Marshal(elliptic.P256(), elliptic.P256().Params().Gx, elliptic.P256().Params().Gy)
	invalidPrefix := append([]byte(nil), validP256...)
	invalidPrefix[0] = 0x05

	tests := []struct {
		name  string
		key   []byte
		valid bool
	}{
		{name: "X25519", key: make([]byte, 32), valid: true},
		{name: "P-256", key: validP256, valid: true},
		{name: "invalid P-256 prefix", key: invalidPrefix, valid: false},
		{name: "invalid P-256 point", key: make([]byte, 65), valid: false},
		{name: "invalid length", key: make([]byte, 64), valid: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if actual := validPublicKey(test.key); actual != test.valid {
				t.Fatalf("validPublicKey() = %t, want %t", actual, test.valid)
			}
		})
	}
}

func TestOriginPolicy(t *testing.T) {
	if err := ConfigureAllowedOrigins("https://app.example.com"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ConfigureAllowedOrigins("") })

	tests := []struct {
		origin  string
		host    string
		allowed bool
	}{
		{origin: "", host: "ring.example.com", allowed: true},
		{origin: "http://ring.example.com", host: "ring.example.com", allowed: true},
		{origin: "https://app.example.com", host: "ring.example.com", allowed: true},
		{origin: "https://evil.example.com", host: "ring.example.com", allowed: false},
	}

	for _, test := range tests {
		request := httptest.NewRequest(http.MethodGet, "http://"+test.host+"/api/ws", nil)
		request.Header.Set("Origin", test.origin)
		if actual := IsOriginAllowed(request); actual != test.allowed {
			t.Errorf("origin %q: expected %t, got %t", test.origin, test.allowed, actual)
		}
	}
}

func initAPITestDB(t *testing.T) (int64, int64) {
	t.Helper()
	database, err := db.InitDB(t.TempDir() + "/api-test.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	insertUser := func(username string) int64 {
		result, err := database.Exec(
			"INSERT INTO users (username, password_hash, public_key) VALUES (?, ?, ?)",
			username, "hash", make([]byte, 32),
		)
		if err != nil {
			t.Fatal(err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	return insertUser("alice"), insertUser("bob")
}

func requestForUser(method, target, body string, userID int64) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	ctx := context.WithValue(request.Context(), "userID", userID)
	return request.WithContext(ctx)
}

func TestGetMessagesValidatesConversationUser(t *testing.T) {
	aliceID, _ := initAPITestDB(t)
	tests := []struct {
		path   string
		status int
	}{
		{path: "/api/messages/", status: http.StatusBadRequest},
		{path: "/api/messages/0", status: http.StatusBadRequest},
		{path: "/api/messages/-1", status: http.StatusBadRequest},
		{path: "/api/messages/1/extra", status: http.StatusBadRequest},
		{path: "/api/messages/not-a-number", status: http.StatusBadRequest},
		{path: "/api/messages/9999", status: http.StatusNotFound},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			handleGetMessages(recorder, requestForUser(http.MethodGet, test.path, "", aliceID))
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.status, recorder.Body.String())
			}
		})
	}
}

func TestSendMessageValidatesRecipient(t *testing.T) {
	aliceID, _ := initAPITestDB(t)
	encodedContent := base64.StdEncoding.EncodeToString([]byte("ciphertext"))
	encodedNonce := base64.StdEncoding.EncodeToString(make([]byte, 12))
	tests := []struct {
		name       string
		receiverID int64
		status     int
	}{
		{name: "negative", receiverID: -1, status: http.StatusBadRequest},
		{name: "self", receiverID: aliceID, status: http.StatusBadRequest},
		{name: "missing", receiverID: 9999, status: http.StatusNotFound},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"receiver_id":%d,"client_id":"client-message-id","content":%q,"nonce":%q}`, test.receiverID, encodedContent, encodedNonce)
			recorder := httptest.NewRecorder()
			handleSendMessage(recorder, requestForUser(http.MethodPost, "/api/messages", body, aliceID))
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.status, recorder.Body.String())
			}
		})
	}
}

func TestClearMessagesValidatesOtherUser(t *testing.T) {
	aliceID, _ := initAPITestDB(t)
	tests := []struct {
		name        string
		otherUserID int64
		status      int
	}{
		{name: "zero", otherUserID: 0, status: http.StatusBadRequest},
		{name: "self", otherUserID: aliceID, status: http.StatusBadRequest},
		{name: "missing", otherUserID: 9999, status: http.StatusNotFound},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"other_user_id":%d}`, test.otherUserID)
			recorder := httptest.NewRecorder()
			handleClearMessages(recorder, requestForUser(http.MethodPost, "/api/messages/clear", body, aliceID))
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.status, recorder.Body.String())
			}
		})
	}
}

func TestMessagePaginationOnlyReturnsCursorWhenMoreExist(t *testing.T) {
	aliceID, bobID := initAPITestDB(t)
	for index := range 2 {
		if _, _, err := db.SaveMessage(aliceID, bobID, fmt.Sprintf("pagination-id-%02d", index), "text", []byte("ciphertext"), make([]byte, 12)); err != nil {
			t.Fatal(err)
		}
	}

	requestPage := func() struct {
		Messages   []db.Message `json:"messages"`
		NextCursor *int64       `json:"next_cursor"`
	} {
		recorder := httptest.NewRecorder()
		handleGetMessages(recorder, requestForUser(http.MethodGet, fmt.Sprintf("/api/messages/%d?limit=2", bobID), "", aliceID))
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
		}
		var response struct {
			Messages   []db.Message `json:"messages"`
			NextCursor *int64       `json:"next_cursor"`
		}
		if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
			t.Fatal(err)
		}
		return response
	}

	page := requestPage()
	if len(page.Messages) != 2 || page.NextCursor != nil {
		t.Fatalf("exact page should not have a cursor: %+v", page)
	}
	if _, _, err := db.SaveMessage(aliceID, bobID, "pagination-id-02", "text", []byte("ciphertext"), make([]byte, 12)); err != nil {
		t.Fatal(err)
	}
	page = requestPage()
	if len(page.Messages) != 2 || page.NextCursor == nil {
		t.Fatalf("page with another result should have a cursor: %+v", page)
	}
}

func TestGetMeDistinguishesDatabaseFailure(t *testing.T) {
	aliceID, _ := initAPITestDB(t)
	if err := db.DB.Close(); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handleGetMe(recorder, requestForUser(http.MethodGet, "/api/users/me", "", aliceID))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
}
