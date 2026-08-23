const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e7, // 10MB limit for image uploads
  cors: { origin: "*" }
});

app.use(express.static('public'));

// In-memory data structures (Note: Clears on server restart)
const users = {}; // { username: password }
const channels = { general: [] };

// Basic profanity list (expand as needed)
const BAD_WORDS = ['badword1', 'badword2', 'fuck', 'shit', 'bitch', 'ass', 'crap', 'bastard', 'dick'];

function filterProfanity(text) {
  if (!text) return '';
  let filtered = text;
  BAD_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    filtered = filtered.replace(regex, '***');
  });
  return filtered;
}

// 24-hour message expiration cleanup
function cleanExpiredMessages(channelName) {
  if (!channels[channelName]) return;
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  channels[channelName] = channels[channelName].filter(msg => (now - msg.rawTimestamp) < ONE_DAY_MS);
}

setInterval(() => {
  Object.keys(channels).forEach(cleanExpiredMessages);
}, 15 * 60 * 1000);

io.on('connection', (socket) => {

  // Handle Authentication / Registration
  socket.on('auth-user', ({ username, password }, callback) => {
    const cleanUser = username.trim();
    if (!cleanUser || !password) {
      return callback({ success: false, error: "Username and password required." });
    }

    if (users[cleanUser]) {
      // Existing user: check password
      if (users[cleanUser] === password) {
        callback({ success: true, username: cleanUser });
      } else {
        callback({ success: false, error: "Incorrect password for this username." });
      }
    } else {
      // New user: register
      users[cleanUser] = password;
      callback({ success: true, username: cleanUser });
    }
  });

  // Handle Username Change (requires current password)
  socket.on('change-username', ({ currentName, newName, password }, callback) => {
    const cleanNew = newName.trim();
    if (!cleanNew) return callback({ success: false, error: "New username cannot be empty." });

    if (users[currentName] !== password) {
      return callback({ success: false, error: "Incorrect password." });
    }

    if (users[cleanNew] && cleanNew !== currentName) {
      return callback({ success: false, error: "Username already taken." });
    }

    delete users[currentName];
    users[cleanNew] = password;
    callback({ success: true, newName: cleanNew });
  });

  socket.on('join-channel', (channelName) => {
    socket.join(channelName);
    cleanExpiredMessages(channelName);
    socket.emit('channel-history', channels[channelName] || []);
  });

  socket.on('send-message', ({ channel, username, text, image }) => {
    cleanExpiredMessages(channel);

    const msgData = {
      username,
      text: filterProfanity(text),
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
