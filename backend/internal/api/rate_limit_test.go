package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRateLimiterEnforcesCapacityAndRefills(t *testing.T) {
	limiter := newRateLimiter(2, time.Minute)
	now := time.Date(2026, time.July, 12, 12, 0, 0, 0, time.UTC)

	for i := 0; i < 2; i++ {
		if allowed, _ := limiter.allow("client", now); !allowed {
			t.Fatalf("request %d was unexpectedly limited", i+1)
		}
	}
	if allowed, retryAfter := limiter.allow("client", now); allowed || retryAfter != 30*time.Second {
		t.Fatalf("expected 30 second retry, got allowed=%t retry=%s", allowed, retryAfter)
	}
	if allowed, _ := limiter.allow("client", now.Add(30*time.Second)); !allowed {
		t.Fatal("token did not refill")
	}
}

func TestRateLimitMiddlewareReturnsRetryAfter(t *testing.T) {
	limiter := newRateLimiter(1, time.Hour)
	handler := rateLimitByIP(limiter, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	request := httptest.NewRequest(http.MethodPost, "/api/login", nil)
	request.RemoteAddr = "192.0.2.10:1234"
	handler(httptest.NewRecorder(), request)

	recorder := httptest.NewRecorder()
	handler(recorder, request)
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("expected status 429, got %d", recorder.Code)
	}
	if recorder.Header().Get("Retry-After") == "" {
		t.Fatal("missing Retry-After header")
	}
}

func TestClientIPOnlyTrustsForwardingHeadersWhenConfigured(t *testing.T) {
	request := httptest.NewRequest("GET", "http://ring.example.com", nil)
	request.RemoteAddr = "192.0.2.10:1234"
	request.Header.Set("X-Forwarded-For", "198.51.100.20, 192.0.2.10")

	if err := ConfigureTrustedProxyHeaders(""); err != nil {
		t.Fatal(err)
	}
	if actual := clientIP(request); actual != "192.0.2.10" {
		t.Fatalf("untrusted forwarded address was used: %s", actual)
	}
	if err := ConfigureTrustedProxyHeaders("true"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ConfigureTrustedProxyHeaders("") })
	if actual := clientIP(request); actual != "198.51.100.20" {
		t.Fatalf("trusted forwarded address was not used: %s", actual)
	}
}

func TestRateLimiterSeparatesKeysAndCanReset(t *testing.T) {
	limiter := newRateLimiter(1, time.Hour)
	now := time.Date(2026, time.July, 12, 12, 0, 0, 0, time.UTC)
	if allowed, _ := limiter.allow("one", now); !allowed {
		t.Fatal("first key was unexpectedly limited")
	}
	if allowed, _ := limiter.allow("two", now); !allowed {
		t.Fatal("second key shared the first key's limit")
	}
	limiter.reset("one")
	if allowed, _ := limiter.allow("one", now); !allowed {
		t.Fatal("reset key remained limited")
	}
}
