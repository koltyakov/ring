package ws

import (
	"chatapp/internal/db"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 65536 // 64KB
)

var (
	hub     *Hub
	hubOnce sync.Once
)

// GetHub returns the singleton hub instance
func GetHub() *Hub {
	hubOnce.Do(func() {
		hub = NewHub()
		hub.Run()
	})
	return hub
}

type Hub struct {
	Clients    map[int64]*Client // userID -> client
	Register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex
}

type Client struct {
	Hub      *Hub
	Conn     *websocket.Conn
	Send     chan []byte
	UserID   int64
	Username string
}

type WSMessage struct {
	Type      string          `json:"type"` // message, typing, presence, call_offer, call_answer, call_ice, call_end
	Payload   json.RawMessage `json:"payload"`
	Timestamp int64           `json:"timestamp"`
}

type Message struct {
	Type      string `json:"type"`
	From      int64  `json:"from"`
	To        int64  `json:"to,omitempty"`
	Content   []byte `json:"content,omitempty"`
	Nonce     []byte `json:"nonce,omitempty"`
	Timestamp int64  `json:"timestamp"`
	Data      []byte `json:"data,omitempty"` // For WebRTC signaling
}

type Presence struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Online   bool   `json:"online"`
}

func NewHub() *Hub {
	return &Hub{
		Clients:    make(map[int64]*Client),
		Register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

func (h *Hub) Run() {
	go h.handleEvents()
}

func (h *Hub) handleEvents() {
	for {
		select {
		case client := <-h.Register:
			h.mu.Lock()
			// Close existing connection for this user if any (e.g. from reconnect)
			if existing, ok := h.Clients[client.UserID]; ok {
				log.Printf("Closing stale connection for user %d", client.UserID)
				delete(h.Clients, client.UserID)
				close(existing.Send)
			}
			// Send current online users to the new client
			for id, c := range h.Clients {
				if id != client.UserID {
					msg := Message{
						Type: "presence",
						Data: func() []byte {
							p := Presence{
								UserID:   c.UserID,
								Username: c.Username,
								Online:   true,
							}
							b, _ := json.Marshal(p)
							return b
						}(),
						Timestamp: time.Now().Unix(),
					}
					select {
					case client.Send <- h.serializeMessage(msg):
					default:
					}
				}
			}
			h.Clients[client.UserID] = client
			h.mu.Unlock()
			h.notifyPresence(client.UserID, client.Username, true)
			db.UpdateLastSeen(client.UserID)

		case client := <-h.unregister:
			h.mu.Lock()
			// Only remove and notify offline if this is still the active client
			// (prevents a stale connection from marking the user offline after reconnect)
			if existing, ok := h.Clients[client.UserID]; ok && existing == client {
				delete(h.Clients, client.UserID)
				close(client.Send)
				h.mu.Unlock()
				h.notifyPresence(client.UserID, client.Username, false)
			} else {
				h.mu.Unlock()
			}
		}
	}
}

func (h *Hub) serializeMessage(msg Message) []byte {
	data, _ := json.Marshal(msg)
	return data
}

// notifyPresence sends presence updates directly to all connected clients.
// This must NOT use the broadcast channel since it's called from handleEvents.
func (h *Hub) notifyPresence(userID int64, username string, online bool) {
	msg := Message{
		Type: "presence",
		Data: func() []byte {
			p := Presence{
				UserID:   userID,
				Username: username,
				Online:   online,
			}
			b, _ := json.Marshal(p)
			return b
		}(),
		Timestamp: time.Now().Unix(),
	}
	data := h.serializeMessage(msg)

	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, client := range h.Clients {
		select {
		case client.Send <- data:
		default:
		}
	}
}

// SendMessage sends a message directly to a specific online user.
func (h *Hub) SendMessage(to int64, msg Message) {
	msg.To = to
	data := h.serializeMessage(msg)

	h.mu.RLock()
	client, ok := h.Clients[to]
	h.mu.RUnlock()
	if ok {
		select {
		case client.Send <- data:
		default:
			log.Printf("Failed to send message to user %d: send buffer full", to)
		}
	}
}

func (h *Hub) IsOnline(userID int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.Clients[userID]
	return ok
}

func (h *Hub) GetOnlineUsers() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	users := make([]int64, 0, len(h.Clients))
	for id := range h.Clients {
		users = append(users, id)
	}
	return users
}

func (c *Client) ReadPump() {
	defer func() {
		c.Hub.unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		var wsMsg WSMessage
		if err := json.Unmarshal(message, &wsMsg); err != nil {
			continue
		}

		c.handleMessage(&wsMsg)
	}
}

func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			c.Conn.WriteMessage(websocket.TextMessage, message)

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) handleMessage(msg *WSMessage) {
	switch msg.Type {
	case "typing":
		// Forward typing indicator to recipient
		var payload struct {
			To     int64 `json:"to"`
			Typing bool  `json:"typing"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err == nil {
			c.Hub.SendMessage(payload.To, Message{
				Type:      "typing",
				From:      c.UserID,
				Data:      msg.Payload,
				Timestamp: time.Now().Unix(),
			})
		}

	case "call_offer", "call_answer", "call_ice", "call_end":
		// WebRTC signaling
		var payload struct {
			To   int64           `json:"to"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err == nil {
			c.Hub.SendMessage(payload.To, Message{
				Type:      msg.Type,
				From:      c.UserID,
				Data:      payload.Data,
				Timestamp: time.Now().Unix(),
			})
		}
	}
}
