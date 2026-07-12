# Ring

A lightweight encrypted chat and voice/video calling application built with Go and React.

## Features

- Client-Side Encryption - Messages encrypted using X25519/P-256 + AES-GCM
- Mobile First - Optimized for mobile devices, works as PWA
- Voice & Video Calls - WebRTC-powered peer-to-peer calling
- Lightweight & Fast - Go backend with SQLite, React frontend
- Private Invites - Invite-only registration
- Real-time Messaging - WebSocket-based instant messaging

## Tech Stack

**Backend:**

- Go 1.25+
- net/http (standard library)
- SQLite (WAL mode)
- Gorilla WebSocket

**Frontend:**

- React 19 + TypeScript
- Tailwind CSS
- Vite
- Zustand (state management)

## Quick Start

### Prerequisites

- Go 1.25 or later
- Node.js 24.12 and npm 11.6 (pinned with Volta)

### Installation

1. Clone the repository:

```bash
git clone https://github.com/koltyakov/ring.git
cd ring
```

2. Install dependencies:

```bash
make setup
```

3. Configure a JWT signing secret:

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
```

4. Start development servers:

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

1. Access the app at `http://localhost:5173` during development or `http://localhost:8080` after a production build.
2. Create the first user. An invite is not required while the database has no users:

```bash
# Start fresh if necessary, then register through the application
make db-reset
make dev
```

### Creating Invite Codes

Any authenticated user can create an invite through the profile screen or API:

```bash
curl -X POST http://localhost:8080/api/invites \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Or via Make:

```bash
make create-invite
```

## Architecture

### E2E Encryption

- Each client generates a Curve25519 keypair on first use
- Public keys are exchanged through the server
- Shared secrets derived using X25519
- Messages encrypted with AES-GCM using the shared secret

The current key directory is trusted: the server stores mutable public keys and clients do not yet verify fingerprints or key changes. The protocol also has no forward secrecy or multi-device key history. It protects content from passive database inspection, but it is not designed to resist a malicious key-distribution server.

### WebRTC Calling

- Peer-to-peer connection after signaling
- STUN servers for NAT discovery
- Supports voice and video
- DTLS-SRTP encrypted media
- Optional TURN relay support for restrictive networks

## Security Considerations

- Authentication and private-key material are currently stored in browser `localStorage`; an origin-level script compromise can access both
- Contact keys are not fingerprint-verified, and automatic key replacement can make old history unavailable
- JWT tokens expire after 7 days
- WebSocket connections are authenticated
- WebSocket connections use short-lived, single-use tickets exchanged with the bearer token
- Production deployments require HTTPS and a strong, private `JWT_SECRET`

## Development Notes

- WebSocket auth exchanges the JWT for a 30-second single-use ticket at `/api/ws-ticket`.
- Call signaling uses WebSocket event types: `call_offer`, `call_answer`, `call_ice`, `call_end`.
- In dev, the frontend relies on the Vite proxy (`/api` -> `http://localhost:8080`) and uses same-origin in production builds.

## API Endpoints

| Method | Endpoint              | Description                               |
| ------ | --------------------- | ----------------------------------------- |
| POST   | /api/register         | Register new user                         |
| POST   | /api/login            | Login existing user                       |
| POST   | /api/invite/validate  | Validate invite code                      |
| GET    | /api/users            | List all users                            |
| GET    | /api/users/me         | Get current user                          |
| POST   | /api/users/update-key | Update public key                         |
| GET    | /api/messages/:userID | Get a message page (`before_id`, `limit`) |
| POST   | /api/messages         | Send message                              |
| POST   | /api/messages/clear   | Clear messages                            |
| GET    | /api/ws               | WebSocket connection                      |
| POST   | /api/ws-ticket        | Create a single-use WebSocket ticket      |
| POST   | /api/invites          | Create invite                             |
| GET    | /health               | Health check                              |

### Environment Variables

**Backend:**

- `PORT` - Server port (default: 8080)
- `JWT_SECRET` - Required JWT signing secret (at least 32 characters)
- `DB_PATH` - SQLite path (default: `chatapp.db` relative to the backend process)
- `ALLOWED_ORIGINS` - Comma-separated additional HTTP origins; same-origin requests are always allowed

**Frontend build:**

- `VITE_API_BASE_URL` - Optional API origin when it differs from the page origin
- `VITE_WS_BASE_URL` - Optional WebSocket origin when it differs from the page origin
- `VITE_TURN_URL` - Optional `turn:` or `turns:` relay URL
- `VITE_TURN_USERNAME` - TURN username
- `VITE_TURN_CREDENTIAL` - TURN credential

For production, serve the frontend and API over HTTPS, set a persistent `DB_PATH`, configure a WAL-aware SQLite backup, and provide TURN credentials if calls must work across restrictive networks. Numbered database migrations run transactionally at startup, so back up the database before deploying a new version. `/health` checks database readiness, and the server drains HTTP requests on `SIGTERM` and `SIGINT`.

## License

MIT
