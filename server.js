const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configure Socket.IO with faster ping intervals for instant offline detection
const io = new Server(server, {
  pingInterval: 10000, 
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Data Stores
const users = new Map();             // username -> { avatarUrl, isAdmin, code }
const friendsData = new Map();       // username -> Set of friend usernames
const pendingRequests = new Map();   // username -> Set of incoming request usernames
const onlineUsers = new Map();       // socketId -> username
const nameRequests = [];             // Array of { id, oldUsername, newUsername }
let channels = ['general', 'gaming', 'memes'];
const roomMessages = new Map();      // targetRoom -> Array of message objects

// Default Admin User Setup
users.set('admin', { avatarUrl: 'https://via.placeholder.com/150', isAdmin: true, code: 'admin123' });

io.on('connection', (socket) => {

  // Helper function to broadcast online users list instantly
  function broadcastOnlineUsers() {
    const userList = Array.from(onlineUsers.values()).map(uname => ({
      username: uname
    }));
    io.emit('update-online-users', userList);
  }

  // Helper function to get DM room identifier (alphabetically sorted so both users get the same room)
  function getDmRoom(u1, u2) {
    return [u1.toLowerCase(), u2.toLowerCase()].sort().join('_dm_');
  }

  // Authentication & Verification
  socket.on('verify-code', ({ username, code }, callback) => {
    if (!username || !code) {
      return callback({ success: false, error: 'Username and passcode are required.' });
    }

    const existingUser = users.get(username);
    if (existingUser) {
      if (existingUser.code !== code) {
        return callback({ success: false, error: 'Incorrect passcode for existing user.' });
      }
      return callback({
        success: true,
        username,
        avatarUrl: existingUser.avatarUrl,
        isAdmin: existingUser.isAdmin
      });
    }

    // Register new user automatically
    const newUser = {
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`,
      isAdmin: false,
      code
    };
    users.set(username, newUser);

    callback({
      success: true,
      username,
      avatarUrl: newUser.avatarUrl,
      isAdmin: newUser.isAdmin
    });
  });

  // User Initial Connection setup
  socket.on('user-connected', (username) => {
    socket.username = username;
    onlineUsers.set(socket.id, username);

    if (!friendsData.has(username)) {
      friendsData.set(username, new Set());
    }
    if (!pendingRequests.has(username)) {
      pendingRequests.set(username, new Set());
    }

    // Send channels, friends list, and pending requests
    socket.emit('update-channels', channels);
    socket.emit('update-friends-list', Array.from(friendsData.get(username)));
    socket.emit('update-friend-requests', Array.from(pendingRequests.get(username)));
    socket.emit('update-name-requests', nameRequests);

    // Broadcast instant online update to all clients
    broadcastOnlineUsers();
  });

  // Room Joining (Channels or DMs)
  socket.on('join-room', ({ target, type }) => {
    // Leave previous room subscriptions if applicable
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
    }

    const room = type === 'channel' ? target : getDmRoom(socket.username, target);
    socket.currentRoom = room;
    socket.join(room);

    // Send history for the requested channel/DM
    const history = roomMessages.get(room) || [];
    socket.emit('load-history', history);
  });

  // Messaging System
  socket.on('send-message', ({ target, type, username, text }) => {
    const room = type === 'channel' ? target : getDmRoom(username, target);
    const user = users.get(username) || { avatarUrl: '' };

    // Extract @mentions
    const mentions = [];
    const mentionMatches = text.match(/@([a-zA-Z0-9_]+)/g);
    if (mentionMatches) {
      mentionMatches.forEach(m => mentions.push(m.substring(1).toLowerCase()));
    }

    const msgObj = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      username,
      avatarUrl: user.avatarUrl,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      text,
      mentions,
      reactions: {}
    };

    if (!roomMessages.has(room)) {
      roomMessages.set(room, []);
    }
    roomMessages.get(room).push(msgObj);

    // Keep history trimmed to last 100 messages per room to optimize performance
    if (roomMessages.get(room).length > 100) {
      roomMessages.get(room).shift();
    }

    io.to(room).emit('receive-message', msgObj);

    // Direct Ping Audio & Push Notifications
    if (mentions.length > 0) {
      Array.from(io.sockets.sockets.values()).forEach(s => {
        if (s.username && mentions.includes(s.username.toLowerCase())) {
          s.emit('user-pinged', {
            sender: username,
            roomName: type === 'channel' ? `#${target}` : `@${username}`,
            text
          });
        }
      });
    }
  });

  // Message Reactions
  socket.on('toggle-reaction', ({ messageId, emoji }) => {
    if (!socket.currentRoom) return;

    const messages = roomMessages.get(socket.currentRoom);
    if (!messages) return;

    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions[emoji]) {
      msg.reactions[emoji] = [];
    }

    const userIndex = msg.reactions[emoji].indexOf(socket.username);
    if (userIndex > -1) {
      msg.reactions[emoji].splice(userIndex, 1);
      if (msg.reactions[emoji].length === 0) {
        delete msg.reactions[emoji];
      }
    } else {
      msg.reactions[emoji].push(socket.username);
    }

    io.to(socket.currentRoom).emit('update-reactions', {
      messageId,
      reactions: msg.reactions
    });
  });

  // Typing Indicators
  socket.on('typing', ({ target, type, isTyping }) => {
    const room = type === 'channel' ? target : getDmRoom(socket.username, target);
    socket.to(room).emit('user-typing', {
      username: socket.username,
      isTyping
    });
  });

  // MUTUAL FRIEND REQUEST HANDLERS

  socket.on('send-friend-request', ({ targetUsername }, callback) => {
    const sender = socket.username;

    if (!targetUsername || targetUsername.toLowerCase() === sender.toLowerCase()) {
      return callback({ success: false, error: "Invalid target username." });
    }

    // Check if target user exists in records
    const targetExists = Array.from(users.keys()).some(u => u.toLowerCase() === targetUsername.toLowerCase());
    if (!targetExists) {
      return callback({ success: false, error: "User does not exist." });
    }

    const senderFriends = friendsData.get(sender) || new Set();
    if (senderFriends.has(targetUsername)) {
      return callback({ success: false, error: "Already friends!" });
    }

    const targetReqs = pendingRequests.get(targetUsername) || new Set();
    targetReqs.add(sender);
    pendingRequests.set(targetUsername, targetReqs);

    // Notify recipient immediately if online
    const targetSocket = Array.from(io.sockets.sockets.values()).find(s => s.username && s.username.toLowerCase() === targetUsername.toLowerCase());
    if (targetSocket) {
      targetSocket.emit('update-friend-requests', Array.from(targetReqs));
    }

    callback({ success: true, message: "Friend request sent!" });
  });

  socket.on('respond-friend-request', ({ senderUsername, accept }) => {
    const recipient = socket.username;
    const reqs = pendingRequests.get(recipient);

    if (reqs) {
      reqs.delete(senderUsername);
      socket.emit('update-friend-requests', Array.from(reqs));
    }

    if (accept) {
      // Add Recipient -> Sender
      const recipientFriends = friendsData.get(recipient) || new Set();
      recipientFriends.add(senderUsername);
      friendsData.set(recipient, recipientFriends);

      // Add Sender -> Recipient (Mutual Link Fix)
      const senderFriends = friendsData.get(senderUsername) || new Set();
      senderFriends.add(recipient);
      friendsData.set(senderUsername, senderFriends);

      // Instantly push updated friend arrays to BOTH sockets
      socket.emit('update-friends-list', Array.from(recipientFriends));

      const senderSocket = Array.from(io.sockets.sockets.values()).find(s => s.username && s.username.toLowerCase() === senderUsername.toLowerCase());
      if (senderSocket) {
        senderSocket.emit('update-friends-list', Array.from(senderFriends));
      }
    }
  });

  // Channel Creation & Deletion
  socket.on('create-channel', ({ channelName }, callback) => {
    const formatted = channelName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!formatted) return callback({ success: false, error: 'Invalid channel name.' });

    if (channels.includes(formatted)) {
      return callback({ success: false, error: 'Channel already exists.' });
    }

    channels.push(formatted);
    io.emit('update-channels', channels);
    callback({ success: true, channelName: formatted });
  });

  socket.on('delete-channel', ({ channelName }, callback) => {
    const user = users.get(socket.username);
    if (!user || !user.isAdmin) {
      return callback({ success: false, error: 'Admin permission required.' });
    }

    if (channelName === 'general') {
      return callback({ success: false, error: 'Cannot delete default general channel.' });
    }

    channels = channels.filter(c => c !== channelName);
    roomMessages.delete(channelName);
    io.emit('update-channels', channels);
    callback({ success: true });
  });

  // Profile Adjustments & Name Change Requests
  socket.on('update-avatar', ({ avatarUrl }, callback) => {
    const user = users.get(socket.username);
    if (user) {
      user.avatarUrl = avatarUrl;
      callback({ success: true, avatarUrl });
    }
  });

  socket.on('request-username-change', ({ newUsername }, callback) => {
    const trimmed = newUsername.trim();
    if (!trimmed || trimmed.toLowerCase() === socket.username.toLowerCase()) {
      return callback({ success: false, error: 'Invalid new username.' });
    }

    if (users.has(trimmed)) {
      return callback({ success: false, error: 'Username is already taken.' });
    }

    const reqObj = {
      id: 'req_' + Date.now(),
      oldUsername: socket.username,
      newUsername: trimmed
    };

    nameRequests.push(reqObj);
    io.emit('update-name-requests', nameRequests);
    callback({ success: true, message: 'Request submitted to admins.' });
  });

  socket.on('respond-username-change', ({ requestId, accept }, callback) => {
    const user = users.get(socket.username);
    if (!user || !user.isAdmin) {
      return callback({ success: false, error: 'Admin permission required.' });
    }

    const index = nameRequests.findIndex(r => r.id === requestId);
    if (index === -1) return callback({ success: false, error: 'Request not found.' });

    const req = nameRequests[index];
    nameRequests.splice(index, 1);

    if (accept) {
      const existingData = users.get(req.oldUsername);
      if (existingData) {
        users.delete(req.oldUsername);
        users.set(req.newUsername, existingData);

        // Notify client who requested change
        const targetSocket = Array.from(io.sockets.sockets.values()).find(s => s.username === req.oldUsername);
        if (targetSocket) {
          targetSocket.username = req.newUsername;
          targetSocket.emit('username-updated', { newUsername: req.newUsername });
        }
      }
    }

    io.emit('update-name-requests', nameRequests);
    callback({ success: true });
  });

  // Clear Channel/Room History
  socket.on('clear-room-messages', ({ target, type }, callback) => {
    const user = users.get(socket.username);
    if (!user || !user.isAdmin) {
      return callback({ success: false, error: 'Admin permission required.' });
    }

    const room = type === 'channel' ? target : getDmRoom(socket.username, target);
    roomMessages.set(room, []);
    io.to(room).emit('load-history', []);
    callback({ success: true });
  });

  // Instant Offline Status Broadcasting on Disconnect
  socket.on('disconnect', () => {
    if (socket.id) {
      onlineUsers.delete(socket.id);
      broadcastOnlineUsers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server active on port ${PORT}`));
