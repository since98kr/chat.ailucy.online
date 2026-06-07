const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

const ROOMS_FILE = path.join(__dirname, 'rooms.json');

app.use(express.json());

// Helper functions for storage
async function readRooms() {
  try {
    const data = await fs.readFile(ROOMS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeRooms(rooms) {
  await fs.writeFile(ROOMS_FILE, JSON.stringify(rooms, null, 2), 'utf8');
}

// Create room helper API
app.post('/api/rooms', async (req, res) => {
  const { key, name } = req.body;
  if (!key || !name) {
    return res.status(400).json({ error: 'Key and name are required' });
  }

  const rooms = await readRooms();
  rooms[key] = { name };
  await writeRooms(rooms);

  res.status(201).json({ key, name });
});

// Get room helper API
app.get('/api/rooms/:key', async (req, res) => {
  const { key } = req.params;
  const rooms = await readRooms();
  if (!rooms[key]) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({ key, ...rooms[key] });
});

// Rename room API
app.put('/api/rooms/:key', async (req, res) => {
  const { key } = req.params;
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Room name is required' });
  }

  const rooms = await readRooms();
  if (!rooms[key]) {
    return res.status(404).json({ error: 'Room not found' });
  }

  rooms[key].name = name;
  await writeRooms(rooms);

  res.json({ key, name: rooms[key].name });
});

app.get('/', (req, res) => {
  res.send('Chat API is running');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
