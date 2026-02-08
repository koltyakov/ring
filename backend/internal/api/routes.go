package api

import (
	"chatapp/internal/auth"
	"chatapp/internal/crypto"
	"chatapp/internal/db"
	"chatapp/internal/ws"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:   1024,
	WriteBufferSize:  1024,
	HandshakeTimeout: 10 * time.Second,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins in development
	},
}

// JSON response helper
func jsonResponse(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// Error response helper
func errorResponse(w http.ResponseWriter, status int, message string) {
	jsonResponse(w, status, map[string]string{"error": message})
}

// Auth middleware
func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tokenString := r.Header.Get("Authorization")

		// Also check query param for WebSocket connections
		if tokenString == "" {
			tokenString = r.URL.Query().Get("token")
		}

		if tokenString == "" {
			log.Printf("Auth failed: missing token for %s %s", r.Method, r.URL.Path)
			errorResponse(w, http.StatusUnauthorized, "missing authorization")
			return
		}

		// Remove "Bearer " prefix
		if len(tokenString) > 7 && tokenString[:7] == "Bearer " {
			tokenString = tokenString[7:]
		}

		claims, err := auth.ValidateToken(tokenString)
		if err != nil {
			log.Printf("Auth failed: invalid token for %s %s: %v", r.Method, r.URL.Path, err)
			errorResponse(w, http.StatusUnauthorized, "invalid token")
			return
		}

		// Add to context
		ctx := r.Context()
		ctx = context.WithValue(ctx, "userID", claims.UserID)
		ctx = context.WithValue(ctx, "username", claims.Username)
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}

// Get user ID from context
func getUserID(r *http.Request) int64 {
	return r.Context().Value("userID").(int64)
}

// Get username from context
func getUsername(r *http.Request) string {
	return r.Context().Value("username").(string)
}

// SetupRoutes configures all HTTP routes
func SetupRoutes(mux *http.ServeMux) {
	// Static files
	fs := http.FileServer(http.Dir("./static"))
	mux.Handle("/", fs)

	// API routes
	mux.HandleFunc("/api/register", handleRegister)
	mux.HandleFunc("/api/login", handleLogin)
	mux.HandleFunc("/api/invite/validate", handleValidateInvite)

	// Protected routes
	mux.HandleFunc("/api/users", authMiddleware(handleGetUsers))
	mux.HandleFunc("/api/users/me", authMiddleware(handleGetMe))
	mux.HandleFunc("/api/users/update-key", authMiddleware(handleUpdatePublicKey))
	mux.HandleFunc("/api/messages", authMiddleware(handleMessages))
	mux.HandleFunc("/api/messages/", authMiddleware(handleMessages))
	mux.HandleFunc("/api/ws", authMiddleware(handleWebSocket))
	mux.HandleFunc("/api/invites", authMiddleware(handleCreateInvite))
}

func handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req struct {
		Username   string `json:"username"`
		Password   string `json:"password"`
		InviteCode string `json:"invite_code"`
		PublicKey  string `json:"public_key"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errorResponse(w, http.StatusBadRequest, err.Error())
		return
	}

	if req.Username == "" || len(req.Username) < 3 || len(req.Username) > 32 {
		errorResponse(w, http.StatusBadRequest, "invalid username")
		return
	}

	if len(req.Password) < 6 {
		errorResponse(w, http.StatusBadRequest, "password must be at least 6 characters")
		return
	}

	if req.PublicKey == "" {
		errorResponse(w, http.StatusBadRequest, "public key required")
		return
	}

	// Check if this is the first user (bootstrap mode)
	var userCount int
	if err := db.DB.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount); err != nil {
		errorResponse(w, http.StatusInternalServerError, "database error")
		return
	}

	// Require invite code only if users already exist
	if userCount > 0 {
		if req.InviteCode == "" {
			errorResponse(w, http.StatusBadRequest, "invite code required")
			return
		}
		if err := db.ValidateInvite(req.InviteCode); err != nil {
			errorResponse(w, http.StatusBadRequest, "invalid or used invite code")
			return
		}
	}

	// Decode public key
	pubKey, err := crypto.DecodeKey(req.PublicKey)
	if err != nil {
		errorResponse(w, http.StatusBadRequest, "invalid public key")
		return
	}

	// Hash password
	passwordHash, err := db.HashPassword(req.Password)
	if err != nil {
		errorResponse(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	// Create user
	user, err := db.CreateUser(req.Username, passwordHash, pubKey)
	if err != nil {
		errorResponse(w, http.StatusBadRequest, "username already exists")
		return
	}

	// Use the invite code if provided
	if req.InviteCode != "" {
		db.ValidateAndUseInvite(req.InviteCode, user.ID)
	}

	// Generate token
	token, err := auth.GenerateToken(user.ID, user.Username)
	if err != nil {
		errorResponse(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"token": token,
		"user":  user,
	})
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errorResponse(w, http.StatusBadRequest, err.Error())
		return
	}

	if req.Username == "" {
		errorResponse(w, http.StatusBadRequest, "username required")
		return
	}

	if req.Password == "" {
		errorResponse(w, http.StatusBadRequest, "password required")
		return
	}

	// Get user with password hash
	user, err := db.GetUserByUsernameWithPassword(req.Username)
	if err != nil || user == nil {
		errorResponse(w, http.StatusNotFound, "user not found")
		return
	}

	// Verify password
	if !db.CheckPassword(req.Password, user.PasswordHash) {
		errorResponse(w, http.StatusUnauthorized, "invalid password")
		return
	}

	token, err := auth.GenerateToken(user.ID, user.Username)
	if err != nil {
		errorResponse(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"token": token,
		"user":  user,
	})
}

func handleValidateInvite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req struct {
		Code string `json:"code"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errorResponse(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := db.ValidateInvite(req.Code); err != nil {
		errorResponse(w, http.StatusBadRequest, "invalid or used invite code")
		return
	}

	jsonResponse(w, http.StatusOK, map[string]bool{"valid": true})
}

func handleGetUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	users, err := db.GetAllUsers()
	if err != nil {
		errorResponse(w, http.StatusInternalServerError, "failed to fetch users")
		return
	}

	// Get online status
	hub := ws.GetHub()
	response := make([]map[string]interface{}, 0, len(users))
	for _, u := range users {
		response = append(response, map[string]interface{}{
			"id":         u.ID,
			"username":   u.Username,
			"public_key": crypto.EncodeKey(u.PublicKey),
			"created_at": u.CreatedAt,
			"last_seen":  u.LastSeen,
			"online":     hub.IsOnline(u.ID),
		})
	}

	jsonResponse(w, http.StatusOK, response)
}

func handleGetMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	userID := getUserID(r)
	user, err := db.GetUserByID(userID)
	if err != nil || user == nil {
		errorResponse(w, http.StatusNotFound, "user not found")
		return
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"id":         user.ID,
		"username":   user.Username,
		"public_key": crypto.EncodeKey(user.PublicKey),
		"created_at": user.CreatedAt,
		"last_seen":  user.LastSeen,
		"online":     true,
	})
}

func handleUpdatePublicKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	userID := getUserID(r)

	var req struct {
		PublicKey string `json:"public_key"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errorResponse(w, http.StatusBadRequest, err.Error())
		return
	}

	if req.PublicKey == "" {
		errorResponse(w, http.StatusBadRequest, "public key required")
		return
	}

	// Decode public key
	pubKey, err := crypto.DecodeKey(req.PublicKey)
	if err != nil {
		errorResponse(w, http.StatusBadRequest, "invalid public key")
		return
	}

	if err := db.UpdatePublicKey(userID, pubKey); err != nil {
		errorResponse(w, http.StatusInternalServerError, "failed to update public key")
		return
	}

	jsonResponse(w, http.StatusOK, map[string]bool{"success": true})
}

func handleMessages(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		handleGetMessages(w, r)
	case http.MethodPost:
		handleSendMessage(w, r)
	default:
		errorResponse(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func handleGetMessages(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)

	// Extract userID from path /api/messages/{userID}
	path := strings.TrimPrefix(r.URL.Path, "/api/messages/")
	parts := strings.Split(path, "/")
	if len(parts) < 1 || parts[0] == "" {
		errorResponse(w, http.StatusBadRequest, "invalid user ID")
		return
	}

	var otherID int64
	if err := db.DB.QueryRow("SELECT id FROM users WHERE id = ?", parts[0]).Scan(&otherID); err != nil {
		errorResponse(w, http.StatusNotFound, "user not found")
		return
	}

	limit := 50
	offset := 0

	messages, err := db.GetMessagesBetween(userID, otherID, limit, offset)
	if err != nil {
		errorResponse(w, http.StatusInternalServerError, "failed to fetch messages")
		return
	}

	// Mark messages as read and notify sender
	if err := db.MarkMessagesAsRead(otherID, userID); err == nil {
		// Send read receipt via WebSocket
		if ws.GetHub().IsOnline(otherID) {
			readReceiptData, _ := json.Marshal(map[string]int64{"from": userID})
			ws.GetHub().SendMessage(otherID, ws.Message{
				Type:      "read_receipt",
				From:      userID,
				To:        otherID,
				Data:      readReceiptData,
				Timestamp: time.Now().Unix(),
			})
		}
	}

	jsonResponse(w, http.StatusOK, messages)
}

func handleSendMessage(w http.ResponseWriter, r *http.Request) {
	senderID := getUserID(r)

	var req struct {
		ReceiverID int64  `json:"receiver_id"`
		Type       string `json:"type"`
		Content    string `json:"content"`
		Nonce      string `json:"nonce"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errorResponse(w, http.StatusBadRequest, err.Error())
		return
	}

	if req.ReceiverID == 0 || req.Content == "" || req.Nonce == "" {
		errorResponse(w, http.StatusBadRequest, "missing required fields")
		return
	}

	// Decode content and nonce
	content, err := crypto.DecodeKey(req.Content)
	if err != nil {
		errorResponse(w, http.StatusBadRequest, "invalid content encoding")
		return
	}

	nonce, err := crypto.DecodeKey(req.Nonce)
	if err != nil {
		errorResponse(w, http.StatusBadRequest, "invalid nonce encoding")
		return
	}

	msgType := req.Type
	if msgType == "" {
		msgType = "text"
	}

	// Save to database
	msg, err := db.SaveMessage(senderID, req.ReceiverID, msgType, content, nonce)
	if err != nil {
		errorResponse(w, http.StatusInternalServerError, "failed to save message")
		return
	}

	// Send via WebSocket if user is online
	hub := ws.GetHub()
	if hub.IsOnline(req.ReceiverID) {
		hub.SendMessage(req.ReceiverID, ws.Message{
			Type:      "message",
			From:      senderID,
			To:        req.ReceiverID,
			Content:   content,
			Nonce:     nonce,
			Timestamp: msg.Timestamp.Unix(),
		})
	}

	jsonResponse(w, http.StatusOK, msg)
}

func handleClearMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	userID := getUserID(r)

	var req struct {
		OtherUserID int64 `json:"other_user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errorResponse(w, http.StatusBadRequest, "invalid request")
		return
	}

	if err := db.DeleteMessagesBetween(userID, req.OtherUserID); err != nil {
		log.Printf("Failed to clear messages: %v", err)
		errorResponse(w, http.StatusInternalServerError, "failed to clear messages")
		return
	}

	// Notify the other user via WebSocket
	hub := ws.GetHub()
	hub.SendMessage(req.OtherUserID, ws.Message{
		Type:      "clear_messages",
		From:      userID,
		Timestamp: time.Now().Unix(),
	})

	log.Printf("Cleared messages between user %d and %d", userID, req.OtherUserID)
	jsonResponse(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	userID := getUserID(r)
	username := getUsername(r)

	log.Printf("WebSocket connection attempt from user %d (%s)", userID, username)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}

	log.Printf("WebSocket upgraded successfully for user %d", userID)

	hub := ws.GetHub()
	client := &ws.Client{
		Hub:      hub,
		Conn:     conn,
		Send:     make(chan []byte, 256),
		UserID:   userID,
		Username: username,
	}

	hub.Register <- client

	go client.WritePump()
	go client.ReadPump()
}

func handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	code, err := db.GenerateInviteCode()
	if err != nil {
		errorResponse(w, http.StatusInternalServerError, "failed to generate invite")
		return
	}

	jsonResponse(w, http.StatusOK, map[string]string{"code": code})
}
