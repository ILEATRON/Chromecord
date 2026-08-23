const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // Allow file uploads up to ~100MB
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory message store per channel
const channelHistory = {
  general: []
};

// Admin passcode configuration (Change as needed)
const ADMIN_PASSCODE = 'admin123';
const USER_PASSCODE = 'chat123';

// Track connected users & pending name change requests
const activeUsers = new Map(); // socket.id -> { username, isAdmin }
const pendingNameRequests = [];

io.on('connection', (socket) => {

  // Verify access passcode & authenticate user
  socket.on('verify-code', ({ username, code }, callback) => {
    const cleanUser = username.trim();
    if (!cleanUser) {
      return callback({ success: false, error: 'Username required.' });
    }

    let isAdmin = false;
    if (code === ADMIN_PASSCODE) {
      isAdmin = true;
    } else if (code !== USER_PASSCODE) {
      return callback({ success: false, error: 'Invalid passcode.' });
    }

    activeUsers.set(socket.id, { username: cleanUser, isAdmin });
    callback({ success: true, username: cleanUser, isAdmin });

    // Send existing pending admin requests if joining as admin
    if (isAdmin) {
      socket.emit('admin-pending-list', pendingNameRequests);
    }
  });

  // Channel Join Handler
  socket.on('join-channel', (channelName) => {
    socket.join(channelName);
    if (!channelHistory[channelName]) {
      channelHistory[channelName] = [];
    }
    socket.emit('channel-history', channelHistory[channelName]);
  });

  // Handle Incoming Messages & Pings
  socket.on('send-message', (data) => {
    const { channel, username, text, image, mediaType } = data;
    const targetChannel = channel || 'general';

    const msg = {
      id: Date.now(),
      username,
      text: text || '',
      image: image || null,
      mediaType: mediaType || null,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (!channelHistory[targetChannel]) {
      channelHistory[targetChannel] = [];
    }

    channelHistory[targetChannel].push(msg);

    // Limit history memory to last 200 messages per channel
    if (channelHistory[targetChannel].length > 200) {
      channelHistory[targetChannel].shift();
    }

    // Broadcast message to everyone in the room
    io.to(targetChannel).emit('receive-message', msg);

    // Handle Ping Notifications
    if (text) {
      if (text.includes('@everyone')) {
        socket.broadcast.to(targetChannel).emit('user-pinged', {
          sender: username,
          text,
          type: 'everyone'
        });
      } else {
        const mentionRegex = /@(\w+)/g;
        const matches = [...text.matchAll(mentionRegex)].map(m => m[1]);

        matches.forEach(mentionedUser => {
          socket.broadcast.to(targetChannel).emit('user-pinged', {
            targetUser: mentionedUser,
            sender: username,
            text,
            type: 'direct'
          });
        });
      }
    }
  });

  // Typing Indicators
  socket.on('typing', ({ channel, isTyping }) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      socket.to(channel || 'general').emit('user-typing', {
        username: user.username,
        isTyping
      });
    }
  });

  // Name Change Requests
  socket.on('request-name-change', (newName) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    const request = {
      requestId: Date.now().toString(),
      socketId: socket.id,
      oldName: user.username,
      newName: newName.trim()
    };

    pendingNameRequests.push(request);

    // Notify all admin sockets
    for (let [sId, uData] of activeUsers.entries()) {
      if (uData.isAdmin) {
        io.to(sId).emit('admin-pending-list', pendingNameRequests);
      }
    }
  });

  // Admin Decision on Name Change
  socket.on('admin-decide-name', ({ requestId, approved }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !user.isAdmin) return;

    const reqIndex = pendingNameRequests.findIndex(r => r.requestId === requestId);
    if (reqIndex === -1) return;

    const targetReq = pendingNameRequests[reqIndex];
    pendingNameRequests.splice(reqIndex, 1);

    if (approved) {
      const targetUser = activeUsers.get(targetReq.socketId);
      if (targetUser) {
        targetUser.username = targetReq.newName;
        activeUsers.set(targetReq.socketId, targetUser);
      }
      io.to(targetReq.socketId).emit('name-change-approved', targetReq.newName);
    } else {
      io.to(targetReq.socketId).emit('name-change-rejected', 'Your name change request was declined.');
    }

    // Refresh pending list for admins
    for (let [sId, uData] of activeUsers.entries()) {
      if (uData.isAdmin) {
        io.to(sId).emit('admin-pending-list', pendingNameRequests);
      }
    }
  });

  socket.on('disconnect', () => {
    activeUsers.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
