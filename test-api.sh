#!/bin/bash

# Start the server in the background
node index.js > server.log 2>&1 &
SERVER_PID=$!

# Wait for the server to start
sleep 2

# Test room creation
echo "Testing room creation..."
CREATE_RES=$(curl -s -X POST http://localhost:3000/api/rooms \
  -H "Content-Type: application/json" \
  -d '{"key": "room1", "name": "Initial Name"}')
echo "Create Response: $CREATE_RES"

if [[ $CREATE_RES != *"Initial Name"* ]]; then
  echo "Room creation failed!"
  kill $SERVER_PID
  exit 1
fi

# Test room rename
echo "Testing room rename..."
RENAME_RES=$(curl -s -X PUT http://localhost:3000/api/rooms/room1 \
  -H "Content-Type: application/json" \
  -d '{"name": "New Name"}')
echo "Rename Response: $RENAME_RES"

if [[ $RENAME_RES != *"New Name"* ]]; then
  echo "Room rename failed!"
  kill $SERVER_PID
  exit 1
fi

# Verify rename with GET
echo "Verifying rename..."
GET_RES=$(curl -s http://localhost:3000/api/rooms/room1)
echo "Get Response: $GET_RES"

if [[ $GET_RES != *"New Name"* ]]; then
  echo "Rename verification failed!"
  kill $SERVER_PID
  exit 1
fi

echo "All tests passed!"
kill $SERVER_PID
exit 0
