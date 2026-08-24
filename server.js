const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Store online users: socket.id -> username
const onlineUsers = new Map();

// Access passcode configuration
const ACCESS_PASSCODE = '1234'; // Change this to your preferred access code
const ADMIN_PASSCODE = 'admin123'; // Passcode for admin privileges

io.on('connection', (socket) => {

  // Verify access passcode & assign admin status
  socket.on('verify-code', ({ username, code }, callback) => {
    const trimmedUser = username ? username.trim() : '';

    if (!trimmedUser) {
      return callback({ success: false, error: 'Username cannot be empty.' });
    }

    if (code === ACCESS_PASSCODE || code === ADMIN_PASSCODE) {
      const isAdmin = (code === ADMIN_PASSCODE);
      socket.username = trimmedUser;
      socket.isAdmin = isAdmin;

      callback({
        success: true,
        username: trimmedUser,
        isAdmin: isAdmin
      });
    } else {
      callback({ success: false, error: 'Invalid access passcode.' });
    }
  });

  // Track online status
  socket.on('user-connected', (username) => {
    socket.username = username;
    onlineUsers.set(socket.id, username);
    io.emit('update-online-users', Array.from(new Set(onlineUsers.values())));
  });

  // Join a channel or private DM room
  socket.on('join-room', ({ target, type }) => {
    // Leave previous rooms except socket.id room
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }

    let roomName;
    if (type === 'dm') {
      // Deterministic room name for private messaging between 2 users
      roomName = [socket.username.toLowerCase(), target.toLowerCase()].sort().join('--dm--');
    } else {
      roomName = target; // Channels like 'general'
    }

    socket.join(roomName);
    socket.currentRoom = roomName;
  });

  // Handle message routing
  socket.on('send-message', ({ target, type, username, text }) => {
    if (!text || !text.trim()) return;

    let roomName;
    if (type === 'dm') {
      roomName = [username.toLowerCase(), target.toLowerCase()].sort().join('--dm--');
    } else {
      roomName = target;
    }

    const messageData = {
      username,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      target,
      type
    };

    io.to(roomName).emit('receive-message', messageData);
  });

  // Typing indicators
  socket.on('typing', ({ target, type, isTyping }) => {
    let roomName = type === 'dm'
      ? [socket.username.toLowerCase(), target.toLowerCase()].sort().join('--dm--')
      : target;

    socket.to(roomName).emit('user-typing', {
      username: socket.username,
      isTyping
    });
  });

  // Handle user disconnect
  socket.on('disconnect', () => {
    if (socket.id) {
      onlineUsers.delete(socket.id);
      io.emit('update-online-users', Array.from(new Set(onlineUsers.values())));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
