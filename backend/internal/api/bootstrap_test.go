package api

import "testing"

func TestBootstrapSecretConfiguration(t *testing.T) {
	t.Cleanup(func() { _ = ConfigureBootstrapSecret("") })
	if err := ConfigureBootstrapSecret("short"); err == nil {
		t.Fatal("short bootstrap secret was accepted")
	}
	if err := ConfigureBootstrapSecret("0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	if !validBootstrapSecret("0123456789abcdef0123456789abcdef") {
		t.Fatal("configured bootstrap secret was rejected")
	}
	if validBootstrapSecret("wrong-bootstrap-secret") {
		t.Fatal("incorrect bootstrap secret was accepted")
	}
}
