package main

import (
	"bufio"
	"bytes"
	"chatapp/internal/db"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"

	"golang.org/x/term"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "Usage: go run cmd/reset-password/main.go <username>")
		os.Exit(2)
	}
	username := strings.TrimSpace(os.Args[1])
	if username == "" {
		log.Fatal("Username is required")
	}

	password, err := readPassword()
	if err != nil {
		log.Fatal("Failed to read password:", err)
	}
	if len(password) < 8 || len(password) > 72 {
		log.Fatal("Password must be between 8 and 72 characters")
	}

	databasePath := os.Getenv("DB_PATH")
	if databasePath == "" {
		databasePath = "chatapp.db"
	}
	database, err := db.InitDB(databasePath)
	if err != nil {
		log.Fatal("Failed to initialize database:", err)
	}
	defer database.Close()

	user, err := db.GetUserByUsername(username)
	if err != nil {
		log.Fatal("Failed to find user:", err)
	}
	if user == nil {
		log.Fatal("User not found; create the first account through the application")
	}

	passwordHash, err := db.HashPassword(password)
	if err != nil {
		log.Fatal("Failed to hash password:", err)
	}
	if err := db.UpdatePasswordHash(user.ID, passwordHash); err != nil {
		log.Fatal("Failed to update password:", err)
	}
	fmt.Printf("Password updated for user %q.\n", username)
}

func readPassword() (string, error) {
	if password := os.Getenv("CHATAPP_RESET_PASSWORD"); password != "" {
		return password, nil
	}

	stdin := int(os.Stdin.Fd())
	if !term.IsTerminal(stdin) {
		password, err := bufio.NewReader(io.LimitReader(os.Stdin, 1024)).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		return strings.TrimRight(password, "\r\n"), nil
	}

	fmt.Fprint(os.Stderr, "New password: ")
	password, err := term.ReadPassword(stdin)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	fmt.Fprint(os.Stderr, "Confirm password: ")
	confirmation, err := term.ReadPassword(stdin)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if !bytes.Equal(password, confirmation) {
		return "", errors.New("passwords do not match")
	}
	return string(password), nil
}
