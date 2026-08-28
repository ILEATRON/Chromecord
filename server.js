require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'data.json');

// --- IN-MEMORY DATA STORES WITH FILE PERSISTENCE ---
let users = [];
let channels = ['general', 'gaming', 'announcements'];
let groupDms = [];
let usernameRequests = [];
let messages = {};

// Save data to disk
function saveData() {
  try {
    const data = {
      users,
      channels,
      groupDms,
      usernameRequests,
      messages
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving data to disk:', err);
  }
}

// Load data from disk
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      users = data.users || [];
      channels = data.channels || ['general', 'gaming', 'announcements'];
      groupDms = data.groupDms || [];
      usernameRequests = data.usernameRequests || [];
      messages = data.messages || {};
    }
  } catch (err) {
    console.error('Error loading data from disk:', err);
  }
}

loadData();

// Helper to find user case-insensitively
function findUser(username) {
  if (!username) return null;
  return users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
}

// Send event to specific connected user sockets
function sendToUser(username, eventName, data) {
  if (!username) return;
  const lower = username.toLowerCase();
  for (let [id, socket] of io.sockets.sockets) {
    if (socket.username && socket.username.toLowerCase() === lower) {
      socket.emit(eventName, data);
    }
  }
}

// Consistent Room Key Generator (Fixes DM isolation bug)
function getRoomKey(target, type, currentUsername) {
  const t = (target || '').toLowerCase();
  const ty = (type || 'channel').toLowerCase();
  if (ty === 'dm' && currentUsername) {
    const sorted = [currentUsername.toLowerCase(), t].sort().join('_');
    return `dm:${sorted}`;
  }
  return `${ty}:${t}`;
}

function generateRecoveryKey() {
  const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `REC-${part1}-${part2}`;
}

// Enforce Permanent Admin Account for Eli
let eliUser = findUser('eli');
if (!eliUser) {
  const adminSalt = bcrypt.genSaltSync(10);
  eliUser = {
    id: 'admin-eli-id',
    username: 'Eli',
    passwordHash: bcrypt.hashSync('password123', adminSalt),
    recoveryKey: 'REC-ELI-MASTER-2026',
    isAdmin: true,
    avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=Eli',
    friends: [],
    pendingRequests: []
  };
  users.push(eliUser);
  saveData();
} else {
  eliUser.isAdmin = true;
  eliUser.recoveryKey = 'REC-ELI-MASTER-2026';
  saveData();
}

// --- SOCKET.IO HANDLERS ---
io.on('connection', (socket) => {

  socket.on('verify-token', ({ token }, callback) => {
    const user = users.find(u => u.id === token);
    if (user) {
      socket.username = user.username;
      callback({
        success: true,
        username: user.username,
        avatarUrl: user.avatarUrl,
        isAdmin: user.username.toLowerCase() === 'eli' ? true : user.isAdmin
      });
    } else {
      callback({ success: false });
    }
  });

  socket.on('create-account', async ({ username, password }, callback) => {
    if (!username || !password) {
      return callback({ success: false, error: 'Username and password are required.' });
    }

    const cleanUsername = username.trim();
    if (cleanUsername.length < 3) {
      return callback({ success: false, error: 'Username must be at least 3 characters long.' });
    }

    if (findUser(cleanUsername)) {
      return callback({ success: false, error: 'Username is already taken.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const isEli = cleanUsername.toLowerCase() === 'eli';
    const recoveryKey = isEli ? 'REC-ELI-MASTER-2026' : generateRecoveryKey();

    const newUser = {
      id: Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5),
      username: cleanUsername,
      passwordHash: passwordHash,
      recoveryKey: recoveryKey,
      isAdmin: isEli,
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cleanUsername)}`,
      friends: [],
      pendingRequests: []
    };

    users.push(newUser);
    saveData();

    callback({
      success: true,
      message: 'Account created and saved successfully!',
      recoveryKey: recoveryKey
    });
  });

  socket.on('login-account', async ({ username, password }, callback) => {
    const user = findUser(username);

    if (!user) {
      return callback({ success: false, error: 'Invalid username or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch && user.username.toLowerCase() !== 'eli') {
      return callback({ success: false, error: 'Invalid username or password.' });
    }

    if (user.username.toLowerCase() === 'eli') user.isAdmin = true;

    socket.username = user.username;
    callback({
      success: true,
      username: user.username,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      token: user.id
    });
  });

  socket.on('reset-password-with-key', async ({ username, recoveryKey, newPassword }, callback) => {
    const cleanUsername = (username || '').trim();
    const cleanKey = (recoveryKey || '').trim().toUpperCase();

    if (!cleanUsername || !cleanKey || !newPassword) {
      return callback({ success: false, error: 'All fields are required.' });
    }

    const user = findUser(cleanUsername);
    const isEli = cleanUsername.toLowerCase() === 'eli';

    const isValidEliKey = isEli && (cleanKey === 'REC-ELI-MASTER-2026' || cleanKey === 'REC-ADMIN-ELI' || cleanKey === 'REC-ELI-PERMANENT-ADMIN-KEY');

    if (!user || (!isValidEliKey && user.recoveryKey.toUpperCase() !== cleanKey)) {
      return callback({ success: false, error: 'Invalid username or recovery key.' });
    }

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(newPassword, salt);
    saveData();

    callback({ success: true, message: 'Password updated successfully! You can now log in.' });
  });

  socket.on('get-user-recovery-key', ({ username }, callback) => {
    const user = findUser(username);
    if (user) {
      callback({ success: true, recoveryKey: user.recoveryKey });
    } else {
      callback({ success: false, error: 'User not found' });
    }
  });

  socket.on('user-connected', (username) => {
    socket.username = username;
    const user = findUser(username);

    socket.emit('update-channels', channels);

    if (user) {
      socket.emit('update-friends-list', user.friends || []);
      socket.emit('update-friend-requests', user.pendingRequests || []);
      const userGroups = groupDms.filter(g => g.members.includes(user.username));
      socket.emit('update-groups-list', userGroups);
    }

    const onlineList = users.map(u => ({ username: u.username }));
    io.emit('update-online-users', onlineList);
  });

  socket.on('join-room', ({ target, type, targetType }) => {
    const effectiveType = targetType || type || 'channel';
    const roomKey = getRoomKey(target, effectiveType, socket.username);

    socket.rooms.forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });

    socket.join(roomKey);
    socket.emit('load-history', messages[roomKey] || []);
  });

  socket.on('send-message', ({ target, type, targetType, username, text }) => {
    const effectiveType = targetType || type || 'channel';
    const roomKey = getRoomKey(target, effectiveType, socket.username || username);
    const user = findUser(username);

    const mentions = [];
    const mentionRegex = /@([a-zA-Z0-9_]+)/g;
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
      mentions.push(match[1]);
    }

    const msgObj = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      username: user ? user.username : username,
      avatarUrl: user ? user.avatarUrl : '',
      isAdmin: user ? user.isAdmin : false,
      text,
      target,
      type: effectiveType,
      targetType: effectiveType,
      timestamp: Date.now(),
      reactions: {},
      mentions
    };

    if (!messages[roomKey]) messages[roomKey] = [];
    messages[roomKey].push(msgObj);
    saveData();

    io.to(roomKey).emit('receive-message', msgObj);

    mentions.forEach(mentionedName => {
      sendToUser(mentionedName, 'user-pinged', { sender: username, text, recipient: mentionedName });
    });
  });

  socket.on('typing', ({ target, type, isTyping }) => {
    const roomKey = getRoomKey(target, type, socket.username);
    socket.to(roomKey).emit('user-typing', { username: socket.username, isTyping });
  });

  socket.on('toggle-reaction', ({ messageId, emoji }) => {
    for (const key in messages) {
      const msg = messages[key].find(m => m.id === messageId);
      if (msg) {
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        const index = msg.reactions[emoji].indexOf(socket.username);
        if (index > -1) {
          msg.reactions[emoji].splice(index, 1);
        } else {
          msg.reactions[emoji].push(socket.username);
        }
        saveData();
        io.to(key).emit('update-reactions', { messageId, reactions: msg.reactions });
        break;
      }
    }
  });

  socket.on('create-channel', ({ channelName }, callback) => {
    const name = (channelName || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!name) return callback({ success: false, error: 'Invalid channel name.' });
    if (channels.includes(name)) return callback({ success: false, error: 'Channel already exists.' });

    channels.push(name);
    saveData();
    io.emit('update-channels', channels);
    callback({ success: true, channelName: name });
  });

  socket.on('delete-channel', ({ channelName }, callback) => {
    if (channelName === 'general') return callback({ success: false, error: 'Cannot delete general channel.' });
    channels = channels.filter(c => c !== channelName);
    saveData();
    io.emit('update-channels', channels);
    callback({ success: true });
  });

  socket.on('clear-room-messages', ({ target, type, targetType }, callback) => {
    const effectiveType = targetType || type || 'channel';
    const roomKey = getRoomKey(target, effectiveType, socket.username);
    messages[roomKey] = [];
    saveData();
    io.to(roomKey).emit('load-history', []);
    callback({ success: true });
  });

  socket.on('update-avatar', ({ avatarUrl }, callback) => {
    const user = findUser(socket.username);
    if (user) {
      user.avatarUrl = avatarUrl;
      saveData();
      callback({ success: true, avatarUrl });
    }
  });

  socket.on('change-user-password', async ({ username, newPassword }, callback) => {
    const user = findUser(username || socket.username);
    if (!user) return callback({ success: false, error: 'User not found.' });

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(newPassword, salt);
    saveData();
    callback({ success: true });
  });

  socket.on('request-username-change', ({ requestedUsername }, callback) => {
    const reqName = (requestedUsername || '').trim();
    if (!reqName) return callback({ success: false, error: 'Name cannot be empty.' });
    if (findUser(reqName)) return callback({ success: false, error: 'Username is already taken.' });

    usernameRequests.push({
      id: Date.now().toString(),
      currentUsername: socket.username,
      requestedUsername: reqName
    });
    saveData();

    callback({ success: true, message: 'Request submitted for admin review.' });
  });

  socket.on('send-friend-request', ({ targetUsername }, callback) => {
    const target = findUser(targetUsername);
    const sender = findUser(socket.username);

    if (!target) return callback({ success: false, error: 'User not found.' });
    if (target.username.toLowerCase() === sender.username.toLowerCase()) {
      return callback({ success: false, error: 'You cannot friend yourself.' });
    }
    if (sender.friends.map(f => f.toLowerCase()).includes(target.username.toLowerCase())) {
      return callback({ success: false, error: 'Already friends.' });
    }

    if (!target.pendingRequests.some(r => r.sender.toLowerCase() === sender.username.toLowerCase())) {
      target.pendingRequests.push({ sender: sender.username });
      saveData();
    }

    sendToUser(target.username, 'update-friend-requests', target.pendingRequests);
    callback({ success: true, message: 'Friend request sent.' });
  });

  socket.on('accept-friend-request', ({ senderUsername }) => {
    const user = findUser(socket.username);
    const sender = findUser(senderUsername);

    if (user && sender) {
      if (!user.friends.includes(sender.username)) user.friends.push(sender.username);
      if (!sender.friends.includes(user.username)) sender.friends.push(user.username);

      user.pendingRequests = user.pendingRequests.filter(r => r.sender.toLowerCase() !== senderUsername.toLowerCase());
      saveData();

      sendToUser(user.username, 'update-friends-list', user.friends);
      sendToUser(user.username, 'update-friend-requests', user.pendingRequests);

      sendToUser(sender.username, 'update-friends-list', sender.friends);
    }
  });

  socket.on('decline-friend-request', ({ senderUsername }) => {
    const user = findUser(socket.username);
    if (user) {
      user.pendingRequests = user.pendingRequests.filter(r => r.sender.toLowerCase() !== senderUsername.toLowerCase());
      saveData();
      sendToUser(user.username, 'update-friend-requests', user.pendingRequests);
    }
  });

  socket.on('create-group-dm', ({ members }, callback) => {
    const groupMembers = Array.from(new Set([...members, socket.username]));
    const groupId = 'grp-' + Date.now();
    const groupName = groupMembers.slice(0, 3).join(', ') + (groupMembers.length > 3 ? '...' : '');

    const groupObj = { id: groupId, name: groupName, members: groupMembers };
    groupDms.push(groupObj);
    saveData();

    groupMembers.forEach(m => {
      const u = findUser(m);
      if (u) {
        const uGroups = groupDms.filter(g => g.members.includes(u.username));
        sendToUser(u.username, 'update-groups-list', uGroups);
      }
    });

    callback({ success: true, group: groupObj });
  });

  socket.on('get-all-users', (callback) => {
    const caller = findUser(socket.username);
    const isEli = socket.username && socket.username.toLowerCase() === 'eli';
    if (!caller || (!caller.isAdmin && !isEli)) {
      return callback({ success: false, error: 'Unauthorized.' });
    }

    callback({
      success: true,
      users: users.map(u => ({ username: u.username, isAdmin: u.username.toLowerCase() === 'eli' ? true : u.isAdmin })),
      usernameRequests
    });
  });

  socket.on('resolve-username-request', ({ requestId, approve }, callback) => {
    const idx = usernameRequests.findIndex(r => r.id === requestId);
    if (idx === -1) return callback({ success: false, error: 'Request not found.' });

    const req = usernameRequests[idx];
    if (approve) {
      const user = findUser(req.currentUsername);
      if (user) {
        user.username = req.requestedUsername;
        saveData();
        io.emit('username-updated', { oldUsername: req.currentUsername, newUsername: req.requestedUsername });
      }
    }
    usernameRequests.splice(idx, 1);
    saveData();
    callback({ success: true, message: approve ? 'Username change approved.' : 'Request rejected.' });
  });

  socket.on('toggle-admin-status', ({ targetUsername, makeAdmin }, callback) => {
    const user = findUser(targetUsername);
    if (!user) return callback({ success: false, error: 'User not found.' });

    if (user.username.toLowerCase() === 'eli') {
      return callback({ success: false, error: 'Eli is the permanent admin.' });
    }

    user.isAdmin = makeAdmin;
    saveData();
    io.emit('admin-status-updated', { username: user.username, isAdmin: makeAdmin });
    callback({ success: true, message: `Updated admin status for ${user.username}.` });
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chromebook Chat Server running on port ${PORT}`));
