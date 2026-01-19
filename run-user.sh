#!/bin/bash
# Run thunder-swap client with USER role
cd "$(dirname "$0")"

# Copy example files if they don't exist
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

if [ ! -f .env.user ]; then
  cp .env.userexample .env.user
  echo "Created .env.user from .env.userexample"
fi

CLIENT_ROLE=USER npm run dev
