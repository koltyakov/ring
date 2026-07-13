package main

import (
	"chatapp/internal/api"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCORSMiddlewareRejectsDisallowedOriginsBeforeHandler(t *testing.T) {
	if err := api.ConfigureAllowedOrigins(""); err != nil {
		t.Fatal(err)
	}
	called := false
	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "http://ring.example.com/api/login", strings.NewReader(`{"username":"alice"}`))
	request.Header.Set("Origin", "https://evil.example.com")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
	}
	if called {
		t.Fatal("disallowed-origin request reached the handler")
	}
}
