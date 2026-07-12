package api

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

var originPolicy = struct {
	sync.RWMutex
	allowed map[string]struct{}
}{allowed: make(map[string]struct{})}

func ConfigureAllowedOrigins(value string) error {
	allowed := make(map[string]struct{})
	for _, item := range strings.Split(value, ",") {
		origin := strings.TrimSpace(strings.TrimRight(item, "/"))
		if origin == "" {
			continue
		}
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
			return fmt.Errorf("invalid allowed origin %q", item)
		}
		allowed[origin] = struct{}{}
	}

	originPolicy.Lock()
	originPolicy.allowed = allowed
	originPolicy.Unlock()
	return nil
}

func IsOriginAllowed(r *http.Request) bool {
	origin := strings.TrimRight(r.Header.Get("Origin"), "/")
	if origin == "" {
		return true
	}

	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	expectedScheme := "http"
	if r.TLS != nil {
		expectedScheme = "https"
	}
	if forwarded := r.Header.Get("X-Forwarded-Proto"); forwarded == "http" || forwarded == "https" {
		expectedScheme = forwarded
	}
	if parsed.Scheme == expectedScheme && parsed.Host == r.Host {
		return true
	}

	originPolicy.RLock()
	_, ok := originPolicy.allowed[origin]
	originPolicy.RUnlock()
	return ok
}
