const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PASSCODE = "1234"; // Set your chat passcode
const ADMIN_NAME = "eli"; // Change to your exact admin username

// Bad words and slurs filter list
const BAD_WORDS = [
  "fuck", "shit", "bitch", "ass", "asshole", "bastard", 
  "crap", "dick", "pussy", "damn", "slut", "whore",
  "fag", "faggot", "fagot", "gay",
  "nigger", "nigga", "niggah", "nigg", "niggers", "niggas"
];

function censorText(text) {
  if (!text) return text;
  let cleanText = text;
  
  BAD_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    cleanText = cleanText.replace(regex, '*'.repeat(word.length));
  });
  
  return cleanText;
}

let activeUsers = {};
let pendingNameChanges = [];
let chatHistory = {}; 
const MAX_HISTORY = 100;

function broadcastPendingRequestsToAdmins() {
  io.sockets.sockets.forEach((s) => {
    if (activeUsers[s.id]?.toLowerCase() === ADMIN_NAME.toLowerCase()) {
      s.emit('admin-pending-list', pendingNameChanges);
    }
  });
}

io.on('connection', (socket) => {

  socket.on('verify-code', ({ username, code }, callback) => {
    if (code !== PASSCODE) {
      return callback({ success: false, error: "Incorrect passcode." });
    }

    const cleanUsername = censorText(username);
    activeUsers[socket.id] = cleanUsername;
    const isAdmin = (cleanUsername.toLowerCase() === ADMIN_NAME.toLowerCase());

    callback({ success: true, username: cleanUsername, isAdmin });

    if (isAdmin) {
      socket.emit('admin-pending-list', pendingNameChanges);
    }
  });

  socket.on('join-channel', (channel) => {
    socket.join(channel);
    if (!chatHistory[channel]) chatHistory[channel] = [];
    socket.emit('channel-history', chatHistory[channel]);
  });

  socket.on('typing', ({ channel, isTyping }) => {
    const username = activeUsers[socket.id];
    if (!username) return;
    socket.to(channel).emit('user-typing', { username, isTyping });
  });

  socket.on('request-name-change', (newName) => {
    const oldName = activeUsers[socket.id];
    const cleanNewName = censorText(newName);
    if (!oldName || !cleanNewName) return;

    pendingNameChanges = pendingNameChanges.filter(r => r.socketId !== socket.id);

    const request = {
      requestId: Date.now() + Math.random().toString(),
      socketId: socket.id,
      oldName,
      newName: cleanNewName
    };

    pendingNameChanges.push(request);
    socket.emit('name-change-status', { status: 'pending', message: 'Request sent to admin for approval.' });
    broadcastPendingRequestsToAdmins();
  });

  socket.on('admin-decide-name', ({ requestId, approved }) => {
    const currentUsername = activeUsers[socket.id];
    if (currentUsername?.toLowerCase() !== ADMIN_NAME.toLowerCase()) return;

    const reqIndex = pendingNameChanges.findIndex(r => r.requestId === requestId);
    if (reqIndex === -1) return;

    const request = pendingNameChanges[reqIndex];
    pendingNameChanges.splice(reqIndex, 1);

    const targetSocket = io.sockets.sockets.get(request.socketId);

    if (approved) {
      if (targetSocket) {
        activeUsers[request.socketId] = request.newName;
        targetSocket.emit('name-change-approved', request.newName);
      }
    } else {
      if (targetSocket) {
        targetSocket.emit('name-change-rejected', 'Admin rejected your username change.');
      }
    }

    broadcastPendingRequestsToAdmins();
  });

  socket.on('send-message', (data) => {
    const cleanText = censorText(data.text);

    const msg = {
      id: Date.now(), // Unique ID for position tracking
      username: activeUsers[socket.id] || censorText(data.username),
      text: cleanText,
      image: data.image,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (!chatHistory[data.channel]) chatHistory[data.channel] = [];
    chatHistory[data.channel].push(msg);

    if (chatHistory[data.channel].length > MAX_HISTORY) {
      chatHistory[data.channel].shift();
    }

    io.to(data.channel).emit('receive-message', msg);
  });

  socket.on('disconnect', () => {
    delete activeUsers[socket.id];
    pendingNameChanges = pendingNameChanges.filter(r => r.socketId !== socket.id);
    broadcastPendingRequestsToAdmins();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
