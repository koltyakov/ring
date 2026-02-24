package crypto

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/box"
)

// GenerateKeyPair generates a new Curve25519 key pair for E2E encryption
func GenerateKeyPair() (publicKey, privateKey []byte, err error) {
	pub, priv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	return pub[:], priv[:], nil
}

// DeriveSharedSecret derives a shared secret using X25519
func DeriveSharedSecret(privateKey, publicKey []byte) ([]byte, error) {
	var priv, pub [32]byte
	copy(priv[:], privateKey)
	copy(pub[:], publicKey)

	var shared [32]byte
	curve25519.ScalarMult(&shared, &priv, &pub)

	// Hash the shared secret for better security
	hash := sha256.Sum256(shared[:])
	return hash[:], nil
}

// GenerateNonce generates a random nonce for encryption
func GenerateNonce() ([]byte, error) {
	nonce := make([]byte, 24)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return nonce, nil
}

// Encrypt encrypts a message using the shared secret
func Encrypt(message, sharedSecret, nonce []byte) []byte {
	var secret [32]byte
	copy(secret[:], sharedSecret)
	var n [24]byte
	copy(n[:], nonce)

	return box.SealAfterPrecomputation(nil, message, &n, &secret)
}

// Decrypt decrypts a message using the shared secret
func Decrypt(encrypted, sharedSecret, nonce []byte) ([]byte, error) {
	var secret [32]byte
	copy(secret[:], sharedSecret)
	var n [24]byte
	copy(n[:], nonce)

	out, ok := box.OpenAfterPrecomputation(nil, encrypted, &n, &secret)
	if !ok {
		return nil, errors.New("decryption failed")
	}
	return out, nil
}

// EncodeKey encodes a key to base64
func EncodeKey(key []byte) string {
	return base64.StdEncoding.EncodeToString(key)
}

// DecodeKey decodes a key from base64
func DecodeKey(keyStr string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(keyStr)
}
