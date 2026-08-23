const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PASSCODE = "1234"; // Set your chat passcode
const ADMIN_NAME = "eli"; // Change this to your exact admin username

// Store active users and pending name changes
let activeUsers = {}; // socket.id -> username
let pendingNameChanges = []; // { requestId, socketId, oldName, newName }

io.on('connection', (socket) => {
  
  socket.on('verify-code', ({ username, code }, callback) => {
    if (code !== PASSCODE) {
      return callback({ success: false, error: "Incorrect passcode." });
    }
    
    activeUsers[socket.id] = username;
    const isAdmin = (username.toLowerCase() === ADMIN_NAME.toLowerCase());
    
    callback({ success: true, username, isAdmin });

    // Send existing pending requests to admin if reconnected
    if (isAdmin) {
      socket.emit('admin-pending-list', pendingNameChanges);
    }
  });

  socket.on('join-channel', (channel) => {
    socket.join(channel);
  });

  // Request username change
  socket.on('request-name-change', (newName) => {
    const oldName = activeUsers[socket.id];
    if (!oldName || !newName) return;

    const request = {
      requestId: Date.now() + Math.random().toString(),
      socketId: socket.id,
      oldName,
      newName
    };

    pendingNameChanges.push(request);

    // Notify user their request was submitted
    socket.emit('name-change-status', { status: 'pending', message: 'Request sent to admin for approval.' });

    // Broadcast request to all connected instances of the admin
    io.sockets.sockets.forEach((s) => {
      if (activeUsers[s.id]?.toLowerCase() === ADMIN_NAME.toLowerCase()) {
        s.emit('new-name-request', request);
      }
    });
  });

  // Admin approval handling
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

    // Update admin UI list
    io.sockets.sockets.forEach((s) => {
      if (activeUsers[s.id]?.toLowerCase() === ADMIN_NAME.toLowerCase()) {
        s.emit('admin-pending-list', pendingNameChanges);
      }
    });
  });

  socket.on('send-message', (data) => {
    const msg = {
      username: activeUsers[socket.id] || data.username,
      text: data.text,
      image: data.image,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    io.to(data.channel).emit('receive-message', msg);
  });

  socket.on('disconnect', () => {
    delete activeUsers[socket.id];
    pendingNameChanges = pendingNameChanges.filter(r => r.socketId !== socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
