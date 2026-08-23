const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Enable large payloads (10MB limit) for images
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  cors: { origin: "*" }
});

app.use(express.static('public'));

// Universal Passcode
const ACCESS_CODE = "1234";

const channels = { general: [] };

// Profanity & slur list
const BAD_WORDS = [
  'nigger', 'niggers', 'nigga', 'niggas', 'niggah', 'niggahs', 'nigg',
  'fuck', 'shit', 'bitch', 'ass', 'crap', 'bastard', 'dick'
];

function filterProfanity(text) {
  if (!text) return '';
  let filtered = text;
  
  BAD_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    filtered = filtered.replace(regex, '***');
  });

  const nWordBypassRegex = /n[i1l|!][g9]{2}[a4e3r]/gi;
  filtered = filtered.replace(nWordBypassRegex, '***');

  return filtered;
}

// Auto-delete messages older than 24 hours
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

  // Verify Universal Passcode
  socket.on('verify-code', ({ username, code }, callback) => {
    const cleanUser = username.trim();
    if (!cleanUser) {
      return callback({ success: false, error: "Please enter a username." });
    }

    if (code === ACCESS_CODE) {
      callback({ success: true, username: cleanUser });
    } else {
      callback({ success: false, error: "Incorrect passcode." });
    }
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
