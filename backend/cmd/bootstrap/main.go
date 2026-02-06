package main

import (
	"chatapp/internal/crypto"
	"chatapp/internal/db"
	"fmt"
	"log"
	"os"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: go run cmd/bootstrap/main.go <username> <password>")
		fmt.Println("Creates or updates an admin user")
		fmt.Println("Example: go run cmd/bootstrap/main.go admin mypassword123")
		os.Exit(1)
	}

	username := os.Args[1]
	password := os.Args[2]

	// Initialize database
	database, err := db.InitDB("chatapp.db")
	if err != nil {
		log.Fatal("Failed to initialize database:", err)
	}
	defer database.Close()

	// Check if user already exists
	existingUser, err := db.GetUserByUsername(username)
	if err != nil {
		log.Fatal("Failed to check existing user:", err)
	}

	// Hash password
	passwordHash, err := db.HashPassword(password)
	if err != nil {
		log.Fatal("Failed to hash password:", err)
	}

	if existingUser != nil {
		// Update existing user's password
		_, err = db.DB.Exec("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, existingUser.ID)
		if err != nil {
			log.Fatal("Failed to update password:", err)
		}
		fmt.Printf("✅ Password updated for user '%s'\n", username)
		fmt.Printf("   You can now log in with the new password.\n")
		return
	}

	// Generate key pair for new user
	pubKey, _, err := crypto.GenerateKeyPair()
	if err != nil {
		log.Fatal("Failed to generate key pair:", err)
	}

	// Create new user
	user, err := db.CreateUser(username, passwordHash, pubKey)
	if err != nil {
		log.Fatal("Failed to create user:", err)
	}

	fmt.Printf("✅ User created successfully!\n")
	fmt.Printf("   ID: %d\n", user.ID)
	fmt.Printf("   Username: %s\n", user.Username)
	fmt.Printf("\nYou can now log in with:\n")
	fmt.Printf("   Username: %s\n", user.Username)
	fmt.Printf("   Password: %s\n", password)
}
