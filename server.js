const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Increase payload limit to 10MB so users can send images
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  cors: { origin: "*" }
});

app.use(express.static('public'));

// Store messages with exact timestamps
const channels = {
  general: []
};

// Helper: Delete messages older than 24 hours (86,400,000 ms)
function cleanExpiredMessages(channelName) {
  if (!channels[channelName]) return;
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  channels[channelName] = channels[channelName].filter(msg => (now - msg.rawTimestamp) < ONE_DAY_MS);
}

// Clean old messages every 15 minutes automatically
setInterval(() => {
  Object.keys(channels).forEach(cleanExpiredMessages);
}, 15 * 60 * 1000);

io.on('connection', (socket) => {
  socket.on('join-channel', (channelName) => {
    socket.join(channelName);
    cleanExpiredMessages(channelName);
    socket.emit('channel-history', channels[channelName] || []);
  });

  socket.on('send-message', ({ channel, username, text, image }) => {
    cleanExpiredMessages(channel);

    const msgData = {
      username,
      text: text || '',
      image: image || null,
      rawTimestamp: Date.now(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (!channels[channel]) channels[channel] = [];
    channels[channel].push(msgData);

    io.to(channel).emit('receive-message', msgData);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
