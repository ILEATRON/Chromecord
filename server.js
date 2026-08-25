const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// In-memory data structures
const users = {
  // Pre-configured Admin Accounts
  admin: { username: 'Admin', code: '1234', isAdmin: true, avatarUrl: 'https://via.placeholder.com/36' },
  eli: { username: 'Eli', code: '1234', isAdmin: true, avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=Eli' }
};

const channels = ['general'];
const messages = { general: [] };
const friendRequests = {}; // senderUsername -> [receivers]
const friendsList = {};    // username -> [friends]
const nameRequests = [];   // pending username change requests

io.on('connection', (socket) => {

  // Verify access passcode / login
  socket.on('verify-code', ({ username, code }, callback) => {
    const key = username.toLowerCase();
    
    if (!users[key]) {
      // Create new user (isAdmin defaults to false)
      users[key] = {
        username,
        code,
        isAdmin: false,
        avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`
      };
    } else if (users[key].code !== code) {
      return callback({ success: false, error: 'Invalid passcode.' });
    }

    socket.username = users[key].username;
    callback({
      success: true,
      username: users[key].username,
      avatarUrl: users[key].avatarUrl,
      isAdmin: !!users[key].isAdmin
    });
  });

  socket.on('user-connected', (username) => {
    socket.username = username;
    socket.join('general');
    
    // Send initial channel list and friend info
    socket.emit('update-channels', channels);
    socket.emit('update-friends-list', friendsList[username.toLowerCase()] || []);
    
    // Notify room of online users
    const online = Array.from(io.sockets.sockets.values())
      .filter(s => s.username)
      .map(s => ({ username: s.username }));
    io.emit('update-online-users', online);
  });

  // Admin: Get all users
  socket.on('get-all-users', (callback) => {
    const user = users[socket.username?.toLowerCase()];
    if (!user || !user.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Admin access required.' });
    }

    const list = Object.values(users).map(u => ({
      username: u.username,
      isAdmin: !!u.isAdmin
    }));

    callback({ success: true, users: list });
  });

  // Admin: Toggle user admin privileges
  socket.on('toggle-admin-status', ({ targetUsername, makeAdmin }, callback) => {
    const currentUser = users[socket.username?.toLowerCase()];
    if (!currentUser || !currentUser.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Admin access required.' });
    }

    const targetKey = targetUsername.toLowerCase();
    if (!users[targetKey]) {
      return callback({ success: false, error: 'User not found.' });
    }

    // Prevent revoking own admin status
    if (targetKey === socket.username.toLowerCase() && !makeAdmin) {
      return callback({ success: false, error: 'You cannot remove admin privileges from yourself.' });
    }

    users[targetKey].isAdmin = makeAdmin;

    // Notify target user across sockets if online
    for (let [id, s] of io.sockets.sockets) {
      if (s.username && s.username.toLowerCase() === targetKey) {
        s.emit('admin-status-updated', { username: users[targetKey].username, isAdmin: makeAdmin });
      }
    }

    callback({ success: true, message: `Updated ${users[targetKey].username}'s admin status.` });
  });

  // Join channel or DM room
  socket.on('join-room', ({ target, type }) => {
    const roomName = type === 'dm' ? [socket.username, target].sort().join('-') : target;
    
    // Leave previous rooms except individual socket ID room
    Array.from(socket.rooms).forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });

    socket.join(roomName);

    // Send history
    const roomHistory = messages[roomName] || [];
    socket.emit('load-history', roomHistory);
  });

  // Send message
  socket.on('send-message', ({ target, type, username, text }) => {
    const roomName = type === 'dm' ? [username, target].sort().join('-') : target;
    const userKey = username.toLowerCase();
    const sender = users[userKey];

    const messageObj = {
      id: Date.now().toString(),
      username,
      avatarUrl: sender ? sender.avatarUrl : '',
      isAdmin: sender ? !!sender.isAdmin : false,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reactions: {},
      mentions: []
    };

    // Check for @mentions
    const mentions = text.match(/@([a-zA-Z0-9_]+)/g);
    if (mentions) {
      messageObj.mentions = mentions.map(m => m.substring(1).toLowerCase());
      messageObj.mentions.forEach(mentionedUser => {
        for (let [id, s] of io.sockets.sockets) {
          if (s.username && s.username.toLowerCase() === mentionedUser) {
            s.emit('user-pinged', { sender: username, roomName: target, text });
          }
        }
      });
    }

    if (!messages[roomName]) messages[roomName] = [];
    messages[roomName].push(messageObj);

    io.to(roomName).emit('receive-message', messageObj);
  });

  // Admin Only: Create Channel
  socket.on('create-channel', ({ channelName }, callback) => {
    const user = users[socket.username?.toLowerCase()];
    if (!user || !user.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Only admins can create channels.' });
    }

    const cleanName = channelName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!cleanName) return callback({ success: false, error: 'Invalid channel name.' });
    if (channels.includes(cleanName)) return callback({ success: false, error: 'Channel already exists.' });

    channels.push(cleanName);
    messages[cleanName] = [];
    io.emit('update-channels', channels);
    callback({ success: true, channelName: cleanName });
  });

  // Admin Only: Delete Channel
  socket.on('delete-channel', ({ channelName }, callback) => {
    const user = users[socket.username?.toLowerCase()];
    if (!user || !user.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Only admins can delete channels.' });
    }

    if (channelName === 'general') {
      return callback({ success: false, error: 'Cannot delete default channel.' });
    }

    const index = channels.indexOf(channelName);
    if (index !== -1) {
      channels.splice(index, 1);
      delete messages[channelName];
      io.emit('update-channels', channels);
      callback({ success: true });
    } else {
      callback({ success: false, error: 'Channel not found.' });
    }
  });

  // Admin Only: Clear Room Messages
  socket.on('clear-room-messages', ({ target, type }, callback) => {
    const user = users[socket.username?.toLowerCase()];
    if (!user || !user.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Admin access required.' });
    }

    const roomName = type === 'dm' ? [socket.username, target].sort().join('-') : target;
    messages[roomName] = [];
    io.to(roomName).emit('load-history', []);
    callback({ success: true });
  });

  // Toggle Reactions
  socket.on('toggle-reaction', ({ messageId, emoji }) => {
    for (let roomName in messages) {
      const msg = messages[roomName].find(m => m.id === messageId);
      if (msg) {
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        const index = msg.reactions[emoji].indexOf(socket.username);
        
        if (index === -1) {
          msg.reactions[emoji].push(socket.username);
        } else {
          msg.reactions[emoji].splice(index, 1);
        }

        io.to(roomName).emit('update-reactions', { messageId, reactions: msg.reactions });
        break;
      }
    }
  });

  // Profile Updates
  socket.on('update-avatar', ({ avatarUrl }, callback) => {
    const userKey = socket.username?.toLowerCase();
    if (users[userKey]) {
      users[userKey].avatarUrl = avatarUrl;
      callback({ success: true, avatarUrl });
    }
  });

  // Typing Indicator
  socket.on('typing', ({ target, type, isTyping }) => {
    const roomName = type === 'dm' ? [socket.username, target].sort().join('-') : target;
    socket.to(roomName).emit('user-typing', { username: socket.username, isTyping });
  });

  // Disconnect Handler
  socket.on('disconnect', () => {
    const online = Array.from(io.sockets.sockets.values())
      .filter(s => s.username)
      .map(s => ({ username: s.username }));
    io.emit('update-online-users', online);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
