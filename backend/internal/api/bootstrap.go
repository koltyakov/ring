package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"sync"
)

var bootstrapConfiguration struct {
	sync.RWMutex
	secretHash []byte
}

func ConfigureBootstrapSecret(secret string) error {
	bootstrapConfiguration.Lock()
	defer bootstrapConfiguration.Unlock()
	bootstrapConfiguration.secretHash = nil
	if secret == "" {
		return nil
	}
	if len(secret) < 16 {
		return fmt.Errorf("BOOTSTRAP_SECRET must be at least 16 characters")
	}
	hash := sha256.Sum256([]byte(secret))
	bootstrapConfiguration.secretHash = hash[:]
	return nil
}

func validBootstrapSecret(candidate string) bool {
	hash := sha256.Sum256([]byte(candidate))
	bootstrapConfiguration.RLock()
	configured := bootstrapConfiguration.secretHash
	valid := len(configured) == sha256.Size && subtle.ConstantTimeCompare(hash[:], configured) == 1
	bootstrapConfiguration.RUnlock()
	return valid
}
