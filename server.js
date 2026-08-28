require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- NODEMAILER TRANSPORTER CONFIGURATION ---
// Configured specifically to prevent SSL/TLS connection drops on cloud platforms like Render
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Verify SMTP connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Nodemailer SMTP Connection Error:', error);
  } else {
    console.log('✅ Nodemailer is ready to send verification emails.');
  }
});

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

// Default admin account
const defaultAdmin = users.find(u => u.username.toLowerCase() === 'eli');
if (!defaultAdmin) {
  users.push({
    id: 'admin-eli-id',
    username: 'eli',
    email: 'admin@local.com',
    password: 'password123',
    isVerified: true,
    isAdmin: true,
    avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=eli',
    friends: [],
    pendingRequests: []
  });
}

// --- EMAIL VERIFICATION ENDPOINT ---
app.get('/verify-email', (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send('<h1>Invalid Request</h1><p>No verification token provided.</p>');
  }

  const user = users.find(u => u.verificationToken === token);

  if (!user) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Verification Failed</title>
        <style>
          body { background: #313338; color: white; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #2b2d31; padding: 30px; border-radius: 8px; text-align: center; max-width: 400px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
          h1 { color: #f23f43; margin-bottom: 10px; }
          p { color: #dbdee1; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Verification Link Expired</h1>
          <p>This verification link is invalid or the account has already been activated.</p>
        </div>
      </body>
      </html>
    `);
  }

  user.isVerified = true;
  delete user.verificationToken;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Account Verified!</title>
      <style>
        body { background: #313338; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #2b2d31; padding: 32px; border-radius: 12px; text-align: center; max-width: 420px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
        h1 { color: #23a55a; margin-bottom: 12px; }
        p { color: #dbdee1; margin-bottom: 24px; line-height: 1.5; }
        a { background: #5865f2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; transition: background 0.2s; }
        a:hover { background: #4752c4; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Account Verified! 🎉</h1>
        <p>Your account for <strong>${user.username}</strong> has been successfully activated. You can now return to Chromebook Chat and log in.</p>
        <a href="/">Return to Login</a>
      </div>
    </body>
    </html>
  `);
});

// --- SOCKET.IO REALTIME EVENT HANDLERS ---
io.on('connection', (socket) => {

  socket.on('verify-token', ({ token }, callback) => {
    const user = users.find(u => u.id === token && u.isVerified);
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

  socket.on('create-account', async ({ username, email, password }, callback) => {
    if (!username || !email || !password) {
      return callback({ success: false, error: 'Username, email, and password are required.' });
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();

    const verifiedUserExists = users.find(u => u.isVerified && u.username.toLowerCase() === cleanUsername.toLowerCase());
    if (verifiedUserExists) {
      return callback({ success: false, error: 'Username is already taken.' });
    }

    const verifiedEmailExists = users.find(u => u.isVerified && u.email.toLowerCase() === cleanEmail);
    if (verifiedEmailExists) {
      return callback({ success: false, error: 'Email is already registered with an active account.' });
    }

    users = users.filter(u => !(
      !u.isVerified && (u.username.toLowerCase() === cleanUsername.toLowerCase() || u.email.toLowerCase() === cleanEmail)
    ));

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const newUser = {
      id: Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5),
      username: cleanUsername,
      email: cleanEmail,
      password: password,
      isVerified: false,
      verificationToken,
      isAdmin: cleanUsername.toLowerCase() === 'eli',
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cleanUsername)}`,
      friends: [],
      pendingRequests: []
    };

    users.push(newUser);

    const host = socket.handshake.headers.host;
    const protocol = socket.handshake.headers['x-forwarded-proto'] || 'https';
    const verifyLink = `${protocol}://${host}/verify-email?token=${verificationToken}`;

    const mailOptions = {
      from: `"Chromebook Chat" <${process.env.EMAIL_USER}>`,
      to: cleanEmail,
      subject: 'Verify your Chromebook Chat Account',
      html: `
        <div style="font-family: Arial, sans-serif; background: #313338; color: #dbdee1; padding: 24px; border-radius: 8px;">
          <h2 style="color: #ffffff; margin-top: 0;">Welcome to Chromebook Chat, ${cleanUsername}!</h2>
          <p style="font-size: 1rem; line-height: 1.5;">Please click the button below to verify your email address and activate your account:</p>
          <a href="${verifyLink}" style="background: #5865f2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; margin: 16px 0;">Verify Email Address</a>
          <p style="font-size: 0.8em; color: #949ba4;">Or paste this URL into your browser:<br><a href="${verifyLink}" style="color: #00a8fc;">${verifyLink}</a></p>
        </div>
      `
    };

    try {
      await transporter.sendMail(mailOptions);
      callback({
        success: true,
        message: 'Account created! Check your email inbox to verify your account before logging in.'
      });
    } catch (err) {
      console.error('Email sending error details:', err);
      users = users.filter(u => u.id !== newUser.id);
      callback({ success: false, error: 'Failed to send verification email: ' + (err.message || 'Check server logs.') });
    }
  });

  socket.on('login-account', ({ username, password }, callback) => {
    const cleanUsername = (username || '').trim().toLowerCase();
    const user = users.find(u => u.username.toLowerCase() === cleanUsername && u.password === password);

    if (!user) {
      return callback({ success: false, error: 'Invalid username or password.' });
    }

    if (!user.isVerified) {
      return callback({
        success: false,
        error: 'Your email has not been verified yet. Check your inbox for the activation link.'
      });
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

    const onlineList = users.filter(u => u.isVerified).map(u => ({ username: u.username }));
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
    const target = users.find(u => u.username.toLowerCase() === targetUsername.trim().toLowerCase() && u.isVerified);
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

  socket.on('request-password-reset', async ({ identifier }, callback) => {
    const cleanId = identifier.trim().toLowerCase();
    const user = users.find(u => u.isVerified && (u.username.toLowerCase() === cleanId || u.email.toLowerCase() === cleanId));

    if (!user) {
      return callback({ success: false, error: 'No active user found matching that identifier.' });
    }

    const mailOptions = {
      from: `"Chromebook Chat" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: 'Password Recovery for Chromebook Chat',
      html: `
        <div style="font-family: Arial, sans-serif; background: #313338; color: #dbdee1; padding: 20px; border-radius: 8px;">
          <h2>Password Recovery Request</h2>
          <p>Your password for account <strong>${user.username}</strong> is: <code>${user.password}</code></p>
        </div>
      `
    };

    try {
      await transporter.sendMail(mailOptions);
      callback({ success: true, message: 'Password recovery details emailed successfully.' });
    } catch (err) {
      callback({ success: false, error: 'Failed to send recovery email.' });
    }
  });

  socket.on('get-all-users', (callback) => {
    const caller = users.find(u => u.username === socket.username);
    if (!caller || !caller.isAdmin) return callback({ success: false, error: 'Unauthorized.' });

    callback({
      success: true,
      users: users.map(u => ({ username: u.username, isAdmin: u.isAdmin, isVerified: u.isVerified })),
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
