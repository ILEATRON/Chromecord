const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const users = {
  admin: { username: 'Admin', code: '1234', isAdmin: true, avatarUrl: 'https://via.placeholder.com/36' },
  eli: { username: 'Eli', code: '1234', isAdmin: true, avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=Eli' }
};

const channels = ['general'];
const messages = { general: [] };
const friendRequests = {};
const friendsList = {};
const usernameRequests = [];
const groupDms = {};
const userGroups = {};

io.on('connection', (socket) => {

  socket.on('verify-code', ({ username, code }, callback) => {
    const key = username.trim().toLowerCase();
    
    if (!users[key]) {
      return callback({ success: false, error: 'User does not exist.' });
    } else if (users[key].code !== code) {
      return callback({ success: false, error: 'Invalid passcode.' });
    }

    socket.username = users[key].username;
    callback({
      success: true,
      username: users[key].username,
      avatarUrl: users[key].avatarUrl,
      isAdmin: users[key].username.toLowerCase() === 'eli' ? true : !!users[key].isAdmin
    });
  });

  socket.on('create-account', ({ username, code }, callback) => {
    const key = username.trim().toLowerCase();
    
    if (!username.trim() || !code.trim()) {
      return callback({ success: false, error: 'Username and passcode required.' });
    }
    if (users[key]) {
      return callback({ success: false, error: 'Username already taken.' });
    }

    const isPermanentAdmin = key === 'eli';

    users[key] = {
      username: username.trim(),
      code: code.trim(),
      isAdmin: isPermanentAdmin,
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username.trim())}`
    };

    socket.username = users[key].username;
    callback({
      success: true,
      username: users[key].username,
      avatarUrl: users[key].avatarUrl,
      isAdmin: isPermanentAdmin
    });
  });

  socket.on('user-connected', (username) => {
    const key = username.toLowerCase();
    socket.username = username;
    socket.join('general');
    
    if (!friendsList[key]) friendsList[key] = [];
    if (!friendRequests[key]) friendRequests[key] = [];
    if (!userGroups[key]) userGroups[key] = [];

    // Permanent Eli admin check on connect
    if (key === 'eli') {
      users[key].isAdmin = true;
    }

    userGroups[key].forEach(groupId => socket.join(groupId));
    const persistentGroupObjs = userGroups[key].map(id => groupDms[id]).filter(Boolean);

    socket.emit('update-channels', channels);
    socket.emit('update-friends-list', friendsList[key]);
    socket.emit('update-friend-requests', friendRequests[key]);
    socket.emit('update-groups-list', persistentGroupObjs);
    
    const online = Array.from(io.sockets.sockets.values())
      .filter(s => s.username)
      .map(s => ({ username: s.username }));
    io.emit('update-online-users', online);
  });

  socket.on('send-message', ({ target, type, username, text }) => {
    let roomName = target;
    if (type === 'dm') {
      roomName = [username, target].sort().join('-');
    }

    const userKey = username.toLowerCase();
    const sender = users[userKey];

    const messageObj = {
      id: Date.now().toString(),
      target,
      targetType: type,
      username,
      avatarUrl: sender ? sender.avatarUrl : '',
      isAdmin: sender ? !!sender.isAdmin : false,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reactions: {},
      mentions: []
    };

    // Parse `@mentions` and dispatch ping events to matching connected clients
    const mentions = text.match(/@([a-zA-Z0-9_]+)/g);
    if (mentions) {
      const parsedMentions = mentions.map(m => m.substring(1).toLowerCase());
      messageObj.mentions = parsedMentions;

      parsedMentions.forEach(mentionedUser => {
        for (let [id, s] of io.sockets.sockets) {
          if (s.username && s.username.toLowerCase() === mentionedUser) {
            s.emit('user-pinged', { 
              sender: username, 
              target, 
              roomName: target, 
              text 
            });
          }
        }
      });
    }

    if (!messages[roomName]) messages[roomName] = [];
    messages[roomName].push(messageObj);

    io.to(roomName).emit('receive-message', messageObj);
  });

  // Admin status management with unremovable Eli check
  socket.on('toggle-admin-status', ({ targetUsername, makeAdmin }, callback) => {
    const currentUser = users[socket.username?.toLowerCase()];
    if (!currentUser || !currentUser.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Admin access required.' });
    }

    const targetKey = targetUsername.toLowerCase();
    if (!users[targetKey]) {
      return callback({ success: false, error: 'User not found.' });
    }

    // Strict protection: Eli can NEVER be demoted under any circumstances
    if (targetKey === 'eli' && !makeAdmin) {
      return callback({ 
        success: false, 
        error: 'Permanent Admin: Eli cannot have admin privileges removed.' 
      });
    }

    if (targetKey === socket.username.toLowerCase() && !makeAdmin) {
      return callback({ success: false, error: 'You cannot remove admin privileges from yourself.' });
    }

    users[targetKey].isAdmin = makeAdmin;

    for (let [id, s] of io.sockets.sockets) {
      if (s.username && s.username.toLowerCase() === targetKey) {
        s.emit('admin-status-updated', { username: users[targetKey].username, isAdmin: makeAdmin });
      }
    }

    callback({ success: true, message: `Updated ${users[targetKey].username}'s admin status.` });
  });

  socket.on('disconnect', () => {
    const online = Array.from(io.sockets.sockets.values())
      .filter(s => s.username)
      .map(s => ({ username: s.username }));
    io.emit('update-online-users', online);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
