#!/bin/bash
# Run thunder-swap client with LP role
cd "$(dirname "$0")"

# Copy example files if they don't exist
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

if [ ! -f .env.lp ]; then
  cp .env.lpexample .env.lp
  echo "Created .env.lp from .env.lpexample"
fi

CLIENT_ROLE=LP npm run dev
