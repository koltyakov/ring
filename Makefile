.PHONY: all build frontend backend run clean dev setup

# Default target
all: build

# Setup development environment
setup:
	@echo "Installing frontend dependencies..."
	cd frontend && npm install
	@echo "Installing backend dependencies..."
	cd backend && go mod tidy

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
	cd backend && DEBUG=true go run cmd/main.go

dev-frontend:
	cd frontend && npm run dev

# Run production server
run: build
	cd backend && ./chatapp

# Clean build artifacts
clean:
	rm -f backend/chatapp
	rm -rf backend/static/*
	rm -f backend/*.db
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
	rm -f backend/chatapp.db
	@echo "Database reset. Restart the server to reinitialize."

# Help
help:
	@echo "Available targets:"
	@echo "  setup        - Install all dependencies"
	@echo "  build        - Build frontend and backend"
	@echo "  frontend     - Build frontend only"
	@echo "  backend      - Build backend only"
	@echo "  dev          - Start development servers (frontend + backend)"
	@echo "  run          - Run production server"
	@echo "  clean        - Clean all build artifacts"
	@echo "  db-reset     - Reset the database"
	@echo "  help         - Show this help"
