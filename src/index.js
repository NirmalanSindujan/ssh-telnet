const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { handleSession } = require('./sessionManager');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

const PORT = 4000;

wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket');
  handleSession(ws);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
