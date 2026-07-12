package api

import (
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
