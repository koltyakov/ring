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
	Clients    map[int64]map[*Client]struct{} // userID -> active sessions
	Register   chan *Client
	unregister chan *Client
	stop       chan struct{}
	done       chan struct{}
	stopOnce   sync.Once
	mu         sync.RWMutex
}

type Client struct {
	Hub         *Hub
	Conn        *websocket.Conn
	Send        chan []byte
	UserID      int64
	Username    string
	AuthVersion int64
}

type WSMessage struct {
	Type      string          `json:"type"` // message, typing, presence, call_offer, call_answer, call_ice, call_end, clear_messages
	Payload   json.RawMessage `json:"payload"`
	Timestamp int64           `json:"timestamp"`
}

type Message struct {
	ID        int64  `json:"id,omitempty"`
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
		Clients:    make(map[int64]map[*Client]struct{}),
		Register:   make(chan *Client),
		unregister: make(chan *Client),
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
	}
}

func (h *Hub) Run() {
	go h.handleEvents()
}

func (h *Hub) handleEvents() {
	defer close(h.done)
	for {
		select {
		case client := <-h.Register:
			h.mu.Lock()
			wasOffline := len(h.Clients[client.UserID]) == 0
			// Send current online users to the new client
			for id, sessions := range h.Clients {
				if id != client.UserID {
					var username string
					for session := range sessions {
						username = session.Username
						break
					}
					msg := Message{
						Type: "presence",
						Data: func() []byte {
							p := Presence{
								UserID:   id,
								Username: username,
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
			if h.Clients[client.UserID] == nil {
				h.Clients[client.UserID] = make(map[*Client]struct{})
			}
			h.Clients[client.UserID][client] = struct{}{}
			h.mu.Unlock()
			if wasOffline {
				h.notifyPresence(client.UserID, client.Username, true)
			}

		case client := <-h.unregister:
			h.mu.Lock()
			sessions := h.Clients[client.UserID]
			_, registered := sessions[client]
			if registered {
				delete(sessions, client)
				close(client.Send)
			}
			wentOffline := registered && len(sessions) == 0
			if wentOffline {
				delete(h.Clients, client.UserID)
			}
			h.mu.Unlock()
			if wentOffline {
				if err := db.UpdateLastSeen(client.UserID); err != nil {
					log.Printf("Failed to update last seen for user %d: %v", client.UserID, err)
				}
				h.notifyPresence(client.UserID, client.Username, false)
			}

		case <-h.stop:
			h.mu.Lock()
			for _, sessions := range h.Clients {
				for client := range sessions {
					close(client.Send)
					if client.Conn != nil {
						_ = client.Conn.WriteControl(
							websocket.CloseMessage,
							websocket.FormatCloseMessage(websocket.CloseGoingAway, "server shutting down"),
							time.Now().Add(writeWait),
						)
						_ = client.Conn.Close()
					}
				}
			}
			h.Clients = make(map[int64]map[*Client]struct{})
			h.mu.Unlock()
			return
		}
	}
}

func (h *Hub) RegisterClient(client *Client) bool {
	select {
	case h.Register <- client:
		return true
	case <-h.done:
		return false
	}
}

func (h *Hub) Shutdown() {
	h.stopOnce.Do(func() { close(h.stop) })
	<-h.done
}

func (h *Hub) Done() <-chan struct{} {
	return h.done
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
	for id, sessions := range h.Clients {
		if id == userID {
			continue
		}
		for client := range sessions {
			select {
			case client.Send <- data:
			default:
			}
		}
	}
}

// SendMessage sends a message directly to a specific online user.
func (h *Hub) SendMessage(to int64, msg Message) {
	msg.To = to
	data := h.serializeMessage(msg)

	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.Clients[to] {
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
	return len(h.Clients[userID]) > 0
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
		select {
		case c.Hub.unregister <- c:
		case <-c.Hub.Done():
		}
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
		if !c.isAuthorized() {
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
			if err := c.Conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if !ok {
				_ = c.Conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseGoingAway, "server shutting down"))
				return
			}

			if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case <-ticker.C:
			if err := c.Conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if !c.isAuthorized() {
				_ = c.Conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "session revoked"))
				return
			}
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) isAuthorized() bool {
	version, err := db.GetAuthVersion(c.UserID)
	return err == nil && version == c.AuthVersion
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
