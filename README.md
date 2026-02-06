# ChatApp

A lightweight, secure, end-to-end encrypted chat and voice/video calling application built with Go and React.

## Features

- End-to-End Encryption - All messages encrypted using Curve25519 + AES-GCM
- Mobile First - Optimized for mobile devices, works as PWA
- Voice & Video Calls - WebRTC-powered peer-to-peer calling
- Lightweight & Fast - Go backend with SQLite, React frontend
- Private Invites - Invite-only registration
- Real-time Messaging - WebSocket-based instant messaging

## Tech Stack

**Backend:**

- Go 1.21+
- Gin Web Framework
- SQLite (WAL mode)
- Gorilla WebSocket

**Frontend:**

- React 18 + TypeScript
- Tailwind CSS
- Vite
- Zustand (state management)

## Quick Start

### Prerequisites

- Go 1.21 or later
- Node.js 18 or later
- npm or yarn

### Installation

1. Clone the repository:

```bash
git clone <repo-url>
cd chatapp
```

2. Install dependencies:

```bash
make setup
```

3. Start development servers:

```bash
make dev
```

This will start:

- Backend server at `http://localhost:8080`
- Frontend dev server at `http://localhost:5173`

### Building for Production

```bash
make build
make run
```

The frontend will be built into `backend/static/` and served by the Go server on port 8080.

## First Time Setup

1. Access the app at `http://localhost:8080`
2. Create the first admin user by generating an invite code:
   - Temporarily modify the backend to create the first user, or
   - Use the API directly with curl

### Creating the First User

Since the app uses invite-only registration, you need to bootstrap the first user:

```bash
# Option 1: Use the bootstrap script
cd backend && go run cmd/bootstrap/main.go admin yourpassword

# Option 2: Start fresh and register normally (first user doesn't need invite)
rm backend/chatapp.db
cd backend && go run cmd/main.go
# Then open http://localhost:5173 and sign up with any username/password
```

### Creating Invite Codes

Once logged in as an admin, use the API:

```bash
curl -X POST http://localhost:8080/api/invites \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Architecture

### E2E Encryption

- Each client generates a Curve25519 keypair on first use
- Public keys are exchanged through the server
- Shared secrets derived using X25519
- Messages encrypted with AES-GCM using the shared secret

### WebRTC Calling

- Peer-to-peer connection after signaling
- STUN servers for NAT traversal
- Supports voice and video
- End-to-end encrypted media

## Security Considerations

- All messages are E2E encrypted - server cannot read content
- Keys are stored in browser's localStorage (consider using more secure storage in production)
- JWT tokens expire after 7 days
- WebSocket connections are authenticated

## API Endpoints

| Method | Endpoint              | Description            |
| ------ | --------------------- | ---------------------- |
| POST   | /api/register         | Register new user      |
| POST   | /api/login            | Login existing user    |
| POST   | /api/invite/validate  | Validate invite code   |
| GET    | /api/users            | List all users         |
| GET    | /api/users/me         | Get current user       |
| GET    | /api/messages/:userID | Get messages with user |
| POST   | /api/messages         | Send message           |
| GET    | /api/ws               | WebSocket connection   |
| POST   | /api/invites          | Create invite (admin)  |

### Environment Variables

**Backend:**

- `PORT` - Server port (default: 8080)
- `JWT_SECRET` - Secret for JWT signing
- `DEBUG` - Enable debug mode

**Frontend:**

- `VITE_API_URL` - API base URL (dev proxy configured)

## License

MIT
