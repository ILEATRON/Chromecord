const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7
});

app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'db.json');

let db = {
  channels: ['general', 'random', 'lounge'],
  users: {},
  messages: [],
  friends: {},
  pendingRequests: {},
  usernameRequests: []
};

if (fs.existsSync(DB_FILE)) {
  try {
    const rawData = fs.readFileSync(DB_FILE, 'utf8');
    db = { ...db, ...JSON.parse(rawData) };
    if (!db.usernameRequests) db.usernameRequests = [];
    console.log('Database loaded successfully.');
  } catch (err) {
    console.error('Error loading db.json:', err);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving db.json:', err);
  }
}

const onlineUsers = new Map();
const userSockets = new Map();

const ACCESS_PASSCODE = '1234';
const ADMIN_PASSCODE = 'admin123';

function getUserProfile(username) {
  const lower = username.toLowerCase();
  if (!db.users[lower]) {
    db.users[lower] = {
      username,
      avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(username)
    };
    saveDB();
  }
  return db.users[lower];
}

function getFriendsList(username) {
  return db.friends[username.toLowerCase()] || [];
}

function getPendingRequests(username) {
  return db.pendingRequests[username.toLowerCase()] || [];
}

function notifyUserFriendsUpdate(username) {
  const sockId = userSockets.get(username.toLowerCase());
  if (sockId) io.to(sockId).emit('update-friends-list', getFriendsList(username));
}

function notifyUserRequestsUpdate(username) {
  const sockId = userSockets.get(username.toLowerCase());
  if (sockId) io.to(sockId).emit('update-friend-requests', getPendingRequests(username));
}

function broadcastNameRequests() {
  userSockets.forEach((sockId) => {
    const sock = io.sockets.sockets.get(sockId);
    if (sock && sock.isAdmin) {
      sock.emit('update-name-requests', db.usernameRequests);
    }
  });
}

io.on('connection', (socket) => {

  socket.on('verify-code', ({ username, code }, callback) => {
    const trimmedUser = username ? username.trim() : '';

    if (!trimmedUser) return callback({ success: false, error: 'Username cannot be empty.' });

    if (code === ACCESS_PASSCODE || code === ADMIN_PASSCODE) {
      const isAdmin = (code === ADMIN_PASSCODE);
      const profile = getUserProfile(trimmedUser);
      profile.isAdmin = isAdmin;

      socket.username = trimmedUser;
      socket.isAdmin = isAdmin;

      callback({
        success: true,
        username: trimmedUser,
        avatarUrl: profile.avatarUrl,
        isAdmin: isAdmin,
        channels: db.channels
      });
    } else {
      callback({ success: false, error: 'Invalid access passcode.' });
    }
  });

  socket.on('user-connected', (username) => {
    socket.username = username;
    const profile = getUserProfile(username);
    const lowerUser = username.toLowerCase();
    
    onlineUsers.set(socket.id, { username, avatarUrl: profile.avatarUrl });
    userSockets.set(lowerUser, socket.id);

    io.emit('update-online-users', Array.from(onlineUsers.values()));
    socket.emit('update-friends-list', getFriendsList(username));
    socket.emit('update-friend-requests', getPendingRequests(username));
    socket.emit('update-channels', db.channels);

    if (socket.isAdmin) {
      socket.emit('update-name-requests', db.usernameRequests);
    }
  });

  socket.on('update-avatar', ({ avatarUrl }, callback) => {
    if (!socket.username) return;
    const lower = socket.username.toLowerCase();
    
    db.users[lower].avatarUrl = avatarUrl;
    saveDB();

    onlineUsers.set(socket.id, { username: socket.username, avatarUrl });
    io.emit('update-online-users', Array.from(onlineUsers.values()));

    callback({ success: true, avatarUrl });
  });

  socket.on('request-username-change', ({ newUsername }, callback) => {
    const oldName = socket.username;
    const trimmedNew = newUsername ? newUsername.trim() : '';

    if (!trimmedNew) return callback({ success: false, error: 'Username cannot be empty.' });
    if (oldName.toLowerCase() === trimmedNew.toLowerCase()) {
      return callback({ success: false, error: 'New username must be different.' });
    }
    if (db.users[trimmedNew.toLowerCase()]) {
      return callback({ success: false, error: 'Username is already taken.' });
    }
    if (db.usernameRequests.some(r => r.oldUsername.toLowerCase() === oldName.toLowerCase())) {
      return callback({ success: false, error: 'You already have a pending name change request.' });
    }

    const reqObj = {
      id: Date.now().toString(),
      oldUsername: oldName,
      newUsername: trimmedNew
    };

    db.usernameRequests.push(reqObj);
    saveDB();

    broadcastNameRequests();
    callback({ success: true, message: 'Username change submitted for admin approval.' });
  });

  socket.on('respond-username-change', ({ requestId, accept }, callback) => {
    if (!socket.isAdmin) {
      return callback({ success: false, error: 'Only admins can approve username changes.' });
    }

    const reqIndex = db.usernameRequests.findIndex(r => r.id === requestId);
    if (reqIndex === -1) return callback({ success: false, error: 'Request not found.' });

    const { oldUsername, newUsername } = db.usernameRequests[reqIndex];
    db.usernameRequests.splice(reqIndex, 1);

    if (accept) {
      const oldLower = oldUsername.toLowerCase();
      const newLower = newUsername.toLowerCase();

      const oldProfile = db.users[oldLower] || { avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(newUsername) };
      db.users[newLower] = {
        username: newUsername,
        avatarUrl: oldProfile.avatarUrl
      };
      delete db.users[oldLower];

      if (db.friends[oldLower]) {
        db.friends[newLower] = db.friends[oldLower];
        delete db.friends[oldLower];
      }
      Object.keys(db.friends).forEach(user => {
        db.friends[user] = db.friends[user].map(f => f.toLowerCase() === oldLower ? newUsername : f);
      });

      if (db.pendingRequests[oldLower]) {
        db.pendingRequests[newLower] = db.pendingRequests[oldLower];
        delete db.pendingRequests[oldLower];
      }
      Object.keys(db.pendingRequests).forEach(user => {
        db.pendingRequests[user] = db.pendingRequests[user].map(f => f.toLowerCase() === oldLower ? newUsername : f);
      });

      db.messages.forEach(m => {
        if (m.username && m.username.toLowerCase() === oldLower) {
          m.username = newUsername;
        }
        if (m.roomName && m.roomName.includes('--dm--')) {
          const parts = m.roomName.split('--dm--');
          if (parts.includes(oldLower)) {
            const updatedParts = parts.map(p => p === oldLower ? newLower : p).sort();
            m.roomName = updatedParts.join('--dm--');
          }
        }
      });

      saveDB();

      const targetSockId = userSockets.get(oldLower);
      if (targetSockId) {
        const targetSocket = io.sockets.sockets.get(targetSockId);
        if (targetSocket) {
          targetSocket.username = newUsername;
          userSockets.delete(oldLower);
          userSockets.set(newLower, targetSockId);

          onlineUsers.set(targetSockId, { username: newUsername, avatarUrl: oldProfile.avatarUrl });

          targetSocket.emit('username-updated', { newUsername });
        }
      }

      io.emit('update-online-users', Array.from(onlineUsers.values()));
    } else {
      saveDB();
    }

    broadcastNameRequests();
    callback({ success: true });
  });

  socket.on('create-channel', ({ channelName }, callback) => {
    const cleanName = channelName ? channelName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') : '';
    if (!cleanName) return callback({ success: false, error: 'Invalid channel name.' });
    if (db.channels.includes(cleanName)) return callback({ success: false, error: 'Channel already exists.' });

    db.channels.push(cleanName);
    saveDB();

    io.emit('update-channels', db.channels);
    callback({ success: true, channelName: cleanName });
  });

  socket.on('delete-channel', ({ channelName }, callback) => {
    if (!socket.isAdmin) {
      return callback({ success: false, error: 'Only admins can delete channels.' });
    }

    if (channelName === 'general') {
      return callback({ success: false, error: 'Cannot delete default general channel.' });
    }

    db.channels = db.channels.filter(c => c !== channelName);
    db.messages = db.messages.filter(m => m.roomName !== channelName);
    saveDB();

    io.emit('update-channels', db.channels);
    io.emit('channel-deleted', { channelName });

    callback({ success: true });
  });

  socket.on('clear-room-messages', ({ target, type }, callback) => {
    if (!socket.isAdmin) {
      return callback({ success: false, error: 'Only admins can clear message history.' });
    }

    let roomName = (type === 'dm')
      ? [socket.username.toLowerCase(), target.toLowerCase()].sort().join('--dm--')
      : target;

    db.messages = db.messages.filter(m => m.roomName !== roomName);
    saveDB();

    io.to(roomName).emit('load-history', []);
    callback({ success: true });
  });

  socket.on('send-friend-request', ({ targetUsername }, callback) => {
    const sender = socket.username;
    const target = targetUsername ? targetUsername.trim() : '';
    const lowerSender = sender.toLowerCase();
    const lowerTarget = target.toLowerCase();

    if (!target) return callback({ success: false, error: 'Please enter a username.' });
    if (lowerSender === lowerTarget) return callback({ success: false, error: 'You cannot add yourself.' });

    const targetReqs = getPendingRequests(target);
    if (targetReqs.some(r => r.toLowerCase() === lowerSender)) {
      return callback({ success: false, error: 'Friend request already sent.' });
    }

    if (!db.pendingRequests[lowerTarget]) db.pendingRequests[lowerTarget] = [];
    db.pendingRequests[lowerTarget].push(sender);
    saveDB();

    notifyUserRequestsUpdate(target);
    callback({ success: true, message: `Friend request sent to ${target}!` });
  });

  socket.on('respond-friend-request', ({ senderUsername, accept }) => {
    const recipient = socket.username;
    const lowerRecipient = recipient.toLowerCase();
    const lowerSender = senderUsername.toLowerCase();

    let reqs = getPendingRequests(recipient);
    reqs = reqs.filter(r => r.toLowerCase() !== lowerSender);
    db.pendingRequests[lowerRecipient] = reqs;

    if (accept) {
      if (!db.friends[lowerRecipient]) db.friends[lowerRecipient] = [];
      if (!db.friends[lowerSender]) db.friends[lowerSender] = [];

      if (!db.friends[lowerRecipient].includes(senderUsername)) db.friends[lowerRecipient].push(senderUsername);
      if (!db.friends[lowerSender].includes(recipient)) db.friends[recipient.toLowerCase()].push(senderUsername);
    }

    saveDB();

    notifyUserFriendsUpdate(senderUsername);
    notifyUserFriendsUpdate(recipient);
    notifyUserRequestsUpdate(recipient);
  });

  socket.on('join-room', ({ target, type }) => {
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }

    let roomName = (type === 'dm')
      ? [socket.username.toLowerCase(), target.toLowerCase()].sort().join('--dm--')
      : target;

    socket.join(roomName);

    const history = db.messages.filter(m => m.roomName === roomName);
    socket.emit('load-history', history);
  });

  socket.on('send-message', ({ target, type, username, text }) => {
    if (!text || !text.trim()) return;

    let roomName = (type === 'dm')
      ? [username.toLowerCase(), target.toLowerCase()].sort().join('--dm--')
      : target;

    const profile = getUserProfile(username);

    // Extract @mentions
    const mentionMatches = text.match(/@([a-zA-Z0-9_]+)/g) || [];
    const mentions = [...new Set(mentionMatches.map(m => m.substring(1).toLowerCase()))];

    const messageData = {
      id: Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5),
      roomName,
      username,
      avatarUrl: profile.avatarUrl,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      target,
      type,
      reactions: {},
      mentions
    };

    db.messages.push(messageData);
    saveDB();

    io.to(roomName).emit('receive-message', messageData);

    // Emit ping event to mentioned users
    mentions.forEach(mentionedUser => {
      const sockId = userSockets.get(mentionedUser);
      if (sockId) {
        io.to(sockId).emit('user-pinged', {
          sender: username,
          roomName,
          text
        });
      }
    });
  });

  socket.on('toggle-reaction', ({ messageId, emoji }) => {
    const msg = db.messages.find(m => m.id === messageId);
    if (!msg || !socket.username) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

    const userIndex = msg.reactions[emoji].indexOf(socket.username);
    if (userIndex > -1) {
      msg.reactions[emoji].splice(userIndex, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(socket.username);
    }

    saveDB();

    io.to(msg.roomName).emit('update-message-reactions', {
      messageId: msg.id,
      reactions: msg.reactions
    });
  });

  socket.on('typing', ({ target, type, isTyping }) => {
    let roomName = (type === 'dm')
      ? [socket.username.toLowerCase(), target.toLowerCase()].sort().join('--dm--')
      : target;

    socket.to(roomName).emit('user-typing', { username: socket.username, isTyping });
  });

  socket.on('disconnect', () => {
    if (socket.id) {
      const uInfo = onlineUsers.get(socket.id);
      if (uInfo) userSockets.delete(uInfo.username.toLowerCase());
      onlineUsers.delete(socket.id);
      io.emit('update-online-users', Array.from(onlineUsers.values()));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
