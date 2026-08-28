require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- IN-MEMORY DATA STORES ---
let users = [];
let channels = ['general', 'gaming', 'announcements'];
let groupDms = [];
let usernameRequests = [];
let messages = {};

function getRoomKey(target, type) {
  const t = (target || '').toLowerCase();
  const ty = (type || 'channel').toLowerCase();
  return `${ty}:${t}`;
}

// Generate secure random recovery key (e.g. REC-8F3A-12BC)
function generateRecoveryKey() {
  const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `REC-${part1}-${part2}`;
}

// Default Admin Account ('eli')
const defaultAdmin = users.find(u => u.username.toLowerCase() === 'eli');
if (!defaultAdmin) {
  const adminSalt = bcrypt.genSaltSync(10);
  users.push({
    id: 'admin-eli-id',
    username: 'eli',
    passwordHash: bcrypt.hashSync('password123', adminSalt),
    recoveryKey: 'REC-ADMIN-ELI',
    isAdmin: true,
    avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=eli',
    friends: [],
    pendingRequests: []
  });
}

// --- SOCKET.IO HANDLERS ---
io.on('connection', (socket) => {

  // Auto-login verify token
  socket.on('verify-token', ({ token }, callback) => {
    const user = users.find(u => u.id === token);
    if (user) {
      socket.username = user.username;
      callback({
        success: true,
        username: user.username,
        avatarUrl: user.avatarUrl,
        isAdmin: user.isAdmin
      });
    } else {
      callback({ success: false });
    }
  });

  // Create Account (No email required, returns Secret Recovery Key)
  socket.on('create-account', async ({ username, password }, callback) => {
    if (!username || !password) {
      return callback({ success: false, error: 'Username and password are required.' });
    }

    const cleanUsername = username.trim();
    if (cleanUsername.length < 3) {
      return callback({ success: false, error: 'Username must be at least 3 characters long.' });
    }

    const exists = users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());
    if (exists) {
      return callback({ success: false, error: 'Username is already taken.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const recoveryKey = generateRecoveryKey();

    const newUser = {
      id: Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5),
      username: cleanUsername,
      passwordHash: passwordHash,
      recoveryKey: recoveryKey,
      isAdmin: cleanUsername.toLowerCase() === 'eli',
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cleanUsername)}`,
      friends: [],
      pendingRequests: []
    };

    users.push(newUser);

    callback({
      success: true,
      message: 'Account created successfully!',
      recoveryKey: recoveryKey // Send recovery key back to client to show the user
    });
  });

  // Login Account
  socket.on('login-account', async ({ username, password }, callback) => {
    const cleanUsername = (username || '').trim().toLowerCase();
    const user = users.find(u => u.username.toLowerCase() === cleanUsername);

    if (!user) {
      return callback({ success: false, error: 'Invalid username or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return callback({ success: false, error: 'Invalid username or password.' });
    }

    socket.username = user.username;
    callback({
      success: true,
      username: user.username,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      token: user.id
    });
  });

  // SECURE PASSWORD RESET (Requires Username + Secret Recovery Key)
  socket.on('reset-password-with-key', async ({ username, recoveryKey, newPassword }, callback) => {
    const cleanUsername = (username || '').trim().toLowerCase();
    const cleanKey = (recoveryKey || '').trim().toUpperCase();

    if (!cleanUsername || !cleanKey || !newPassword) {
      return callback({ success: false, error: 'All fields are required.' });
    }

    const user = users.find(u => u.username.toLowerCase() === cleanUsername);
    if (!user || user.recoveryKey !== cleanKey) {
      return callback({ success: false, error: 'Invalid username or recovery key.' });
    }

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(newPassword, salt);

    callback({ success: true, message: 'Password updated successfully! You can now log in.' });
  });

  // ADMIN OVERRIDE: Admin can forcibly reset any user's password
  socket.on('admin-reset-user-password', async ({ targetUsername, newPassword }, callback) => {
    const caller = users.find(u => u.username === socket.username);
    if (!caller || !caller.isAdmin) {
      return callback({ success: false, error: 'Unauthorized. Admin access required.' });
    }

    const user = users.find(u => u.username.toLowerCase() === targetUsername.trim().toLowerCase());
    if (!user) return callback({ success: false, error: 'User not found.' });

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(newPassword, salt);

    callback({ success: true, message: `Successfully reset password for ${user.username}.` });
  });

  // User connected setup
  socket.on('user-connected', (username) => {
    socket.username = username;
    const user = users.find(u => u.username.toLowerCase() === (username || '').toLowerCase());

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
    const roomKey = getRoomKey(target, effectiveType);

    socket.rooms.forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });

    socket.join(roomKey);
    socket.emit('load-history', messages[roomKey] || []);
  });

  socket.on('send-message', ({ target, type, targetType, username, text }) => {
    const effectiveType = targetType || type || 'channel';
    const roomKey = getRoomKey(target, effectiveType);
    const user = users.find(u => u.username.toLowerCase() === (username || '').toLowerCase());

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

    io.to(roomKey).emit('receive-message', msgObj);

    mentions.forEach(mentionedName => {
      io.emit('user-pinged', { sender: username, text, recipient: mentionedName });
    });
  });

  socket.on('typing', ({ target, type, isTyping }) => {
    const roomKey = getRoomKey(target, type);
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
    io.emit('update-channels', channels);
    callback({ success: true, channelName: name });
  });

  socket.on('delete-channel', ({ channelName }, callback) => {
    if (channelName === 'general') return callback({ success: false, error: 'Cannot delete general channel.' });
    channels = channels.filter(c => c !== channelName);
    io.emit('update-channels', channels);
    callback({ success: true });
  });

  socket.on('clear-room-messages', ({ target, type, targetType }, callback) => {
    const effectiveType = targetType || type || 'channel';
    const roomKey = getRoomKey(target, effectiveType);
    messages[roomKey] = [];
    io.to(roomKey).emit('load-history', []);
    callback({ success: true });
  });

  socket.on('update-avatar', ({ avatarUrl }, callback) => {
    const user = users.find(u => u.username === socket.username);
    if (user) {
      user.avatarUrl = avatarUrl;
      callback({ success: true, avatarUrl });
    }
  });

  socket.on('request-username-change', ({ requestedUsername }, callback) => {
    const reqName = (requestedUsername || '').trim();
    if (!reqName) return callback({ success: false, error: 'Name cannot be empty.' });

    const exists = users.find(u => u.username.toLowerCase() === reqName.toLowerCase());
    if (exists) return callback({ success: false, error: 'Username is already taken.' });

    usernameRequests.push({
      id: Date.now().toString(),
      currentUsername: socket.username,
      requestedUsername: reqName
    });

    callback({ success: true, message: 'Request submitted for admin review.' });
  });

  socket.on('send-friend-request', ({ targetUsername }, callback) => {
    const target = users.find(u => u.username.toLowerCase() === targetUsername.trim().toLowerCase());
    const sender = users.find(u => u.username === socket.username);

    if (!target) return callback({ success: false, error: 'User not found.' });
    if (target.username === sender.username) return callback({ success: false, error: 'You cannot friend yourself.' });
    if (sender.friends.includes(target.username)) return callback({ success: false, error: 'Already friends.' });

    if (!target.pendingRequests.some(r => r.sender === sender.username)) {
      target.pendingRequests.push({ sender: sender.username });
    }

    callback({ success: true, message: 'Friend request sent.' });
  });

  socket.on('accept-friend-request', ({ senderUsername }) => {
    const user = users.find(u => u.username === socket.username);
    const sender = users.find(u => u.username.toLowerCase() === senderUsername.toLowerCase());

    if (user && sender) {
      user.friends.push(sender.username);
      sender.friends.push(user.username);
      user.pendingRequests = user.pendingRequests.filter(r => r.sender.toLowerCase() !== senderUsername.toLowerCase());

      socket.emit('update-friends-list', user.friends);
      socket.emit('update-friend-requests', user.pendingRequests);
    }
  });

  socket.on('decline-friend-request', ({ senderUsername }) => {
    const user = users.find(u => u.username === socket.username);
    if (user) {
      user.pendingRequests = user.pendingRequests.filter(r => r.sender.toLowerCase() !== senderUsername.toLowerCase());
      socket.emit('update-friend-requests', user.pendingRequests);
    }
  });

  socket.on('create-group-dm', ({ members }, callback) => {
    const groupMembers = Array.from(new Set([...members, socket.username]));
    const groupId = 'grp-' + Date.now();
    const groupName = groupMembers.slice(0, 3).join(', ') + (groupMembers.length > 3 ? '...' : '');

    const groupObj = { id: groupId, name: groupName, members: groupMembers };
    groupDms.push(groupObj);

    groupMembers.forEach(m => {
      const u = users.find(user => user.username === m);
      if (u) {
        const uGroups = groupDms.filter(g => g.members.includes(u.username));
        io.emit('update-groups-list', uGroups);
      }
    });

    callback({ success: true, group: groupObj });
  });

  socket.on('get-all-users', (callback) => {
    const caller = users.find(u => u.username === socket.username);
    if (!caller || !caller.isAdmin) return callback({ success: false, error: 'Unauthorized.' });

    callback({
      success: true,
      users: users.map(u => ({ username: u.username, isAdmin: u.isAdmin })),
      usernameRequests
    });
  });

  socket.on('resolve-username-request', ({ requestId, approve }, callback) => {
    const idx = usernameRequests.findIndex(r => r.id === requestId);
    if (idx === -1) return callback({ success: false, error: 'Request not found.' });

    const req = usernameRequests[idx];
    if (approve) {
      const user = users.find(u => u.username === req.currentUsername);
      if (user) {
        user.username = req.requestedUsername;
        io.emit('username-updated', { oldUsername: req.currentUsername, newUsername: req.requestedUsername });
      }
    }
    usernameRequests.splice(idx, 1);
    callback({ success: true, message: approve ? 'Username change approved.' : 'Request rejected.' });
  });

  socket.on('toggle-admin-status', ({ targetUsername, makeAdmin }, callback) => {
    const user = users.find(u => u.username.toLowerCase() === targetUsername.toLowerCase());
    if (!user) return callback({ success: false, error: 'User not found.' });

    user.isAdmin = makeAdmin;
    io.emit('admin-status-updated', { username: user.username, isAdmin: makeAdmin });
    callback({ success: true, message: `Updated admin status for ${user.username}.` });
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chromebook Chat Server running on port ${PORT}`));
