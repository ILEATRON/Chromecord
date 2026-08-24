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
  users: {}, // username.toLowerCase() -> { username, avatarUrl, isAdmin }
  messages: [], // Array of { id, roomName, username, avatarUrl, text, time, reactions: { "👍": ["user1"] } }
  friends: {},
  pendingRequests: {}
};

if (fs.existsSync(DB_FILE)) {
  try {
    const rawData = fs.readFileSync(DB_FILE, 'utf8');
    db = { ...db, ...JSON.parse(rawData) };
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

  socket.on('create-channel', ({ channelName }, callback) => {
    const cleanName = channelName ? channelName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') : '';
    if (!cleanName) return callback({ success: false, error: 'Invalid channel name.' });
    if (db.channels.includes(cleanName)) return callback({ success: false, error: 'Channel already exists.' });

    db.channels.push(cleanName);
    saveDB();

    io.emit('update-channels', db.channels);
    callback({ success: true, channelName: cleanName });
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
      if (!db.friends[lowerSender].includes(recipient)) db.friends[lowerSender].push(recipient);
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

    const messageData = {
      id: Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5),
      roomName,
      username,
      avatarUrl: profile.avatarUrl,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      target,
      type,
      reactions: {} // emoji -> array of usernames
    };

    db.messages.push(messageData);
    saveDB();

    io.to(roomName).emit('receive-message', messageData);
  });

  // Toggle Reaction on a Message
  socket.on('toggle-reaction', ({ messageId, emoji }) => {
    const msg = db.messages.find(m => m.id === messageId);
    if (!msg || !socket.username) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

    const userIndex = msg.reactions[emoji].indexOf(socket.username);
    if (userIndex > -1) {
      // Remove reaction if user already clicked it
      msg.reactions[emoji].splice(userIndex, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      // Add reaction
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
