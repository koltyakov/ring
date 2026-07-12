package auth

import (
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

const testSecret = "0123456789abcdef0123456789abcdef"

func TestConfigureRejectsWeakSecret(t *testing.T) {
	if err := Configure("too-short"); err == nil {
		t.Fatal("Configure accepted a weak secret")
	}
	if _, err := GenerateToken(1, "alice", 0); err == nil {
		t.Fatal("GenerateToken succeeded without valid configuration")
	}
}

func TestGenerateAndValidateToken(t *testing.T) {
	if err := Configure(testSecret); err != nil {
		t.Fatal(err)
	}

	token, err := GenerateToken(42, "alice", 3)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := ValidateToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.UserID != 42 || claims.Username != "alice" || claims.Version != 3 {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestValidateTokenRejectsOtherSigningMethods(t *testing.T) {
	if err := Configure(testSecret); err != nil {
		t.Fatal(err)
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS384, Claims{UserID: 42, Username: "alice"})
	signed, err := token.SignedString([]byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateToken(signed); err == nil {
		t.Fatal("ValidateToken accepted a non-HS256 token")
	}
}
