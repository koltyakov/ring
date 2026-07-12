package api

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maximumRateLimitEntries = 10000

var trustProxyHeaders atomic.Bool

func ConfigureTrustedProxyHeaders(value string) error {
	if value == "" {
		trustProxyHeaders.Store(false)
		return nil
	}
	trusted, err := strconv.ParseBool(value)
	if err != nil {
		return err
	}
	trustProxyHeaders.Store(trusted)
	return nil
}

type rateLimitBucket struct {
	tokens   float64
	updated  time.Time
	lastSeen time.Time
}

type rateLimiter struct {
	mu              sync.Mutex
	capacity        float64
	refillPerSecond float64
	entryTTL        time.Duration
	entries         map[string]rateLimitBucket
}

func newRateLimiter(capacity int, refillPeriod time.Duration) *rateLimiter {
	return &rateLimiter{
		capacity:        float64(capacity),
		refillPerSecond: float64(capacity) / refillPeriod.Seconds(),
		entryTTL:        2 * refillPeriod,
		entries:         make(map[string]rateLimitBucket),
	}
}

func (l *rateLimiter) allow(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if len(l.entries) >= maximumRateLimitEntries {
		for entryKey, bucket := range l.entries {
			if now.Sub(bucket.lastSeen) > l.entryTTL {
				delete(l.entries, entryKey)
			}
		}
		if _, exists := l.entries[key]; !exists && len(l.entries) >= maximumRateLimitEntries {
			return false, l.entryTTL
		}
	}

	bucket, exists := l.entries[key]
	if !exists {
		bucket = rateLimitBucket{tokens: l.capacity, updated: now}
	}
	if elapsed := now.Sub(bucket.updated).Seconds(); elapsed > 0 {
		bucket.tokens = math.Min(l.capacity, bucket.tokens+elapsed*l.refillPerSecond)
		bucket.updated = now
	}
	bucket.lastSeen = now

	if bucket.tokens < 1 {
		l.entries[key] = bucket
		retryAfter := time.Duration(math.Ceil((1-bucket.tokens)/l.refillPerSecond)) * time.Second
		return false, max(retryAfter, time.Second)
	}
	bucket.tokens--
	l.entries[key] = bucket
	return true, 0
}

func (l *rateLimiter) reset(key string) {
	l.mu.Lock()
	delete(l.entries, key)
	l.mu.Unlock()
}

func clientIP(r *http.Request) string {
	if trustProxyHeaders.Load() {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			if ip := net.ParseIP(strings.TrimSpace(strings.Split(forwarded, ",")[0])); ip != nil {
				return ip.String()
			}
		}
		if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("X-Real-IP"))); ip != nil {
			return ip.String()
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func rateLimitByIP(limiter *rateLimiter, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if allowed, retryAfter := limiter.allow(clientIP(r), time.Now()); !allowed {
			tooManyRequests(w, retryAfter)
			return
		}
		next(w, r)
	}
}

func rateLimitByUser(limiter *rateLimiter, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := strconv.FormatInt(getUserID(r), 10)
		if allowed, retryAfter := limiter.allow(key, time.Now()); !allowed {
			tooManyRequests(w, retryAfter)
			return
		}
		next(w, r)
	}
}

func tooManyRequests(w http.ResponseWriter, retryAfter time.Duration) {
	seconds := max(1, int(math.Ceil(retryAfter.Seconds())))
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	errorResponse(w, http.StatusTooManyRequests, "too many requests; try again later")
}

var (
	loginIPLimiter          = newRateLimiter(10, time.Minute)
	loginAccountLimiter     = newRateLimiter(10, 10*time.Minute)
	registrationIPLimiter   = newRateLimiter(5, 10*time.Minute)
	inviteValidationLimiter = newRateLimiter(20, time.Minute)
	webSocketTicketLimiter  = newRateLimiter(30, time.Minute)
	inviteCreationLimiter   = newRateLimiter(10, time.Hour)
)
