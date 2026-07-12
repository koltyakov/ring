.PHONY: all build frontend backend run clean dev dev-backend dev-frontend setup check test lint typecheck create-invite bootstrap db-reset help

# Default target
all: build

# Setup development environment
setup:
	@echo "Installing frontend dependencies..."
	cd frontend && npm ci
	@echo "Installing backend dependencies..."
	cd backend && go mod download && go mod verify

# Run all required quality checks
check: lint typecheck test

test:
	cd backend && go test -race -shuffle=on ./...

lint:
	cd frontend && npm run lint
	cd backend && go vet ./...

typecheck:
	cd frontend && npm run typecheck

# Build frontend
frontend:
	@echo "Building frontend..."
	cd frontend && npm run build

# Build backend
backend:
	@echo "Building backend..."
	cd backend && go build -o chatapp cmd/main.go

# Build everything
build: frontend backend

# Run development servers
dev:
	@echo "Starting development servers..."
	@make -j2 dev-backend dev-frontend

dev-backend:
	cd backend && ALLOWED_ORIGINS=$${ALLOWED_ORIGINS:-http://localhost:5173} go run cmd/main.go

dev-frontend:
	cd frontend && npm run dev

# Run production server
run: build
	cd backend && ./chatapp

# Clean build artifacts
clean:
	rm -f backend/chatapp
	rm -rf backend/static/*
	rm -rf frontend/node_modules
	rm -rf frontend/dist

# Create admin invite
create-invite:
	@curl -s -X POST http://localhost:8080/api/invites \
		-H "Authorization: Bearer $(shell cat .token 2>/dev/null || echo '')" \
		| grep -o '"code":"[^"]*"' | cut -d'"' -f4

# Bootstrap first user (no invite needed) - usage: make bootstrap USER=admin PASS=secret123
bootstrap:
	@cd backend && go run cmd/bootstrap/main.go $(USER) $(PASS)

# Database operations
db-reset:
	rm -f backend/chatapp.db backend/chatapp.db-shm backend/chatapp.db-wal
	@echo "Database reset. Restart the server to reinitialize."

# Help
help:
	@echo "Available targets:"
	@echo "  setup        - Install all dependencies"
	@echo "  build        - Build frontend and backend"
	@echo "  check        - Run lint, typecheck, and tests"
	@echo "  test         - Run backend tests with the race detector"
	@echo "  lint         - Run frontend lint and Go vet"
	@echo "  typecheck    - Type-check the frontend"
	@echo "  frontend     - Build frontend only"
	@echo "  backend      - Build backend only"
	@echo "  dev          - Start development servers (frontend + backend)"
	@echo "  run          - Run production server"
	@echo "  clean        - Clean all build artifacts"
	@echo "  db-reset     - Reset the database"
	@echo "  help         - Show this help"
