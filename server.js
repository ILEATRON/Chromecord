const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Serve static files from the public folder
app.use(express.static('public'));

// Store messages in memory for active channels
const channels = {
  general: []
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Send message history when a user joins
  socket.on('join-channel', (channelName) => {
    socket.join(channelName);
    socket.emit('channel-history', channels[channelName] || []);
  });

  // Receive and broadcast incoming messages
  socket.on('send-message', ({ channel, username, text }) => {
    const msgData = { 
      username, 
      text, 
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
    };
    
    if (!channels[channel]) channels[channel] = [];
    channels[channel].push(msgData);

    // Keep history under 100 messages
    if (channels[channel].length > 100) channels[channel].shift();

    io.to(channel).emit('receive-message', msgData);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
