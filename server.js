const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-chat-key-change-in-prod';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

const io = new Server(server, {
  maxHttpBufferSize: 1e8 
});

app.use(express.static('public'));

// Setup Mail Transporter (uses env vars if available, falls back to Ethereal test account)
let transporter;

async function initMailer() {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'Gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
  } else {
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass
      }
    });
    console.log('--- TEST EMAIL CONFIGURATION ACTIVE ---');
    console.log(`Ethereal User: ${testAccount.user}`);
  }
}

initMailer().catch(console.error);

async function sendMail({ to, subject, html }) {
  if (!transporter) await initMailer();
  const info = await transporter.sendMail({
    from: '"Chromebook Chat" <no-reply@chromebookchat.com>',
    to,
    subject,
    html
  });

  // If using Ethereal test account, print preview URL to console
  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.log(`[Email Sent] Preview link: ${previewUrl}`);
  }
  return info;
}

// In-memory store
const users = {}; // Keyed by username lowercased
const emailToUsername = {}; // Maps lowercase email to username
const verificationTokens = {}; // token -> username
const resetTokens = {}; // token -> { username, expires }

// Seed initial admin user
(async () => {
  const eliPasswordHash = await bcrypt.hash('4Peasinapod!', 10);
  users['eli'] = { 
    username: 'Eli', 
    email: 'admin@chromebookchat.com',
    passwordHash: eliPasswordHash, 
    isAdmin: true, 
    isVerified: true,
    avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=Eli' 
  };
  emailToUsername['admin@chromebookchat.com'] = 'eli';
})();

const channels = ['general'];
const messages = { general: [] };
const friendRequests = {};
const friendsList = {};
const usernameRequests = [];
const groupDms = {};
const userGroups = {};

const BANNED_WORDS = [
  'gay', 'lesbian', 'homo',
  'faggot', 'fagot', 'fag', 'fags', 'faggots', 'fagots',
  'nigger', 'niggers', 'nigga', 'niggas', 'niggah', 'niggahs', 'nigg3r', 'nigg4', 'n1gger', 'n1gga', 'niga', 'niger',
  'fuck', 'fucker', 'fuckin', 'fucking', 'fucked', 'fuckface', 'fuckhead', 'motherfucker',
  'shit', 'shits', 'shitting', 'shitty', 'bullshit',
  'ass', 'asshole', 'assholes', 'dumbass', 'jackass',
  'bitch', 'bitches', 'bitchy',
  'bastard', 'bastards',
  'cunt', 'cunts',
  'dick', 'dicks', 'dickhead',
  'cock', 'cocks', 'cocksucker', 'jew', 'hitler', 'hilter',
  'pussy', 'pussies',
  'slut', 'sluts',
  'whore', 'whores',
  'prick', 'pricks',
  'piss', 'pissed'
];

const profanityRegex = new RegExp(`\\b(${BANNED_WORDS.join('|')})\\b`, 'gi');

function filterBadWords(text) {
  if (!text) return text;
  let cleanText = text.replace(profanityRegex, (match) => '*'.repeat(match.length));
  cleanText = cleanText.replace(/\b(f[u\*k@!1]+ck|sh[!1i*]t|b[!1i*]tch|a[$\*s]{2,}|c[u\*k@!1]+nt)\b/gi, (match) => '*'.repeat(match.length));
  return cleanText;
}

// HTTP Routes for Email Verification and Password Reset
app.get('/verify-email', (req, res) => {
  const { token } = req.query;
  const username = verificationTokens[token];

  if (!username || !users[username.toLowerCase()]) {
    return res.status(400).send('<h2>Invalid or expired verification link.</h2>');
  }

  const key = username.toLowerCase();
  users[key].isVerified = true;
  delete verificationTokens[token];

  res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #313338; color: #dbdee1; min-height: 100vh;">
      <h2 style="color: #23a55a;">Email Successfully Verified!</h2>
      <p>Your account (<strong>${users[key].username}</strong>) is now fully active.</p>
      <p><a href="/" style="color: #5865f2; text-decoration: none; font-weight: bold;">Return to Chromebook Chat and Log In</a></p>
    </div>
  `);
});

app.get('/reset-password-page', (req, res) => {
  const { token } = req.query;
  const record = resetTokens[token];

  if (!record || record.expires < Date.now()) {
    return res.status(400).send('<h2>Password reset link is invalid or has expired.</h2>');
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Reset Password - Chromebook Chat</title>
      <style>
        body { font-family: sans-serif; background: #313338; color: #dbdee1; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .box { background: #2b2d31; padding: 30px; border-radius: 8px; width: 320px; display: flex; flex-direction: column; gap: 12px; }
        input { padding: 10px; background: #1e1f22; border: 1px solid #3f4147; color: white; border-radius: 4px; outline: none; }
        button { padding: 10px; background: #5865f2; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }
        button:hover { background: #4752c4; }
      </style>
    </head>
    <body>
      <div class="box">
        <h3>Reset Your Password</h3>
        <p style="font-size: 0.85em; color: #949ba4;">Set a new password for account: <b>${record.username}</b></p>
        <form action="/perform-password-reset" method="POST" onsubmit="return validateForm()">
          <input type="hidden" name="token" value="${token}">
          <input type="password" id="pass" name="newPassword" placeholder="New Password (min 6 chars)" required style="width:100%; box-sizing:border-box; margin-bottom: 12px;">
          <button type="submit" style="width:100%;">Update Password</button>
        </form>
      </div>
      <script>
        function validateForm() {
          var p = document.getElementById('pass').value;
          if (p.length < 6) { alert('Password must be at least 6 characters.'); return false; }
          return true;
        }
      </script>
    </body>
    </html>
  `);
});

app.use(express.urlencoded({ extended: true }));

app.post('/perform-password-reset', async (req, res) => {
  const { token, newPassword } = req.body;
  const record = resetTokens[token];

  if (!record || record.expires < Date.now()) {
    return res.status(400).send('<h2>Password reset link is invalid or has expired.</h2>');
  }

  if (!newPassword || newPassword.trim().length < 6) {
    return res.status(400).send('<h2>Password must be at least 6 characters long.</h2>');
  }

  const key = record.username.toLowerCase();
  if (users[key]) {
    users[key].passwordHash = await bcrypt.hash(newPassword, 10);
  }

  delete resetTokens[token];

  res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #313338; color: #dbdee1; min-height: 100vh;">
      <h2 style="color: #23a55a;">Password Reset Successful!</h2>
      <p>Your password has been updated.</p>
      <p><a href="/" style="color: #5865f2; text-decoration: none; font-weight: bold;">Click here to Log In</a></p>
    </div>
  `);
});

io.on('connection', (socket) => {

  // Verify Token (Auto Login)
  socket.on('verify-token', ({ token }, callback) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const key = decoded.username.toLowerCase();
      
      if (!users[key]) {
        return callback({ success: false, error: 'User account no longer exists.' });
      }

      if (!users[key].isVerified) {
        return callback({ success: false, error: 'Please verify your email address before logging in.' });
      }

      socket.username = users[key].username;
      callback({
        success: true,
        token,
        username: users[key].username,
        avatarUrl: users[key].avatarUrl,
        isAdmin: users[key].username.toLowerCase() === 'eli' ? true : !!users[key].isAdmin
      });
    } catch (err) {
      callback({ success: false, error: 'Invalid or expired session token.' });
    }
  });

  // Login
  socket.on('login-account', async ({ username, password }, callback) => {
    const key = username.trim().toLowerCase();
    
    if (!users[key]) {
      return callback({ success: false, error: 'User does not exist.' });
    }

    if (!users[key].isVerified) {
      return callback({ success: false, error: 'Account not verified. Please check your email for the verification link.' });
    }

    const isValidPassword = await bcrypt.compare(password, users[key].passwordHash);
    if (!isValidPassword) {
      return callback({ success: false, error: 'Invalid password.' });
    }

    const token = jwt.sign({ username: users[key].username }, JWT_SECRET, { expiresIn: '7d' });

    socket.username = users[key].username;
    callback({
      success: true,
      token,
      username: users[key].username,
      avatarUrl: users[key].avatarUrl,
      isAdmin: users[key].username.toLowerCase() === 'eli' ? true : !!users[key].isAdmin
    });
  });

  // Request Password Reset Link via Email
  socket.on('request-password-reset', async ({ identifier }, callback) => {
    const cleanId = identifier.trim().toLowerCase();
    let targetUsername = null;

    if (users[cleanId]) {
      targetUsername = users[cleanId].username;
    } else if (emailToUsername[cleanId]) {
      targetUsername = emailToUsername[cleanId];
    }

    if (!targetUsername) {
      return callback({ success: false, error: 'No account found with that username or email address.' });
    }

    const key = targetUsername.toLowerCase();
    const user = users[key];

    const resetToken = crypto.randomBytes(32).toString('hex');
    resetTokens[resetToken] = {
      username: user.username,
      expires: Date.now() + 3600000 // 1 hour expiration
    };

    const resetLink = `${APP_URL}/reset-password-page?token=${resetToken}`;

    try {
      await sendMail({
        to: user.email,
        subject: 'Password Reset Request - Chromebook Chat',
        html: `
          <div style="font-family: sans-serif; background: #2b2d31; color: #dbdee1; padding: 20px; border-radius: 8px;">
            <h2 style="color: #ffffff;">Password Reset Request</h2>
            <p>Hello <strong>${user.username}</strong>,</p>
            <p>You requested a password reset for your Chromebook Chat account. Click the button below to reset it:</p>
            <p style="margin: 20px 0;">
              <a href="${resetLink}" style="background: #5865f2; color: white; padding: 10px 18px; text-decoration: none; border-radius: 4px; font-weight: bold; display: inline-block;">Reset Password</a>
            </p>
            <p style="font-size: 0.8em; color: #949ba4;">This link will expire in 1 hour. If you did not request this, please ignore this email.</p>
          </div>
        `
      });

      callback({ success: true, message: `Password reset link sent to ${user.email}. Please check your inbox.` });
    } catch (err) {
      console.error(err);
      callback({ success: false, error: 'Failed to send reset email. Please try again later.' });
    }
  });

  // Create Account with Email and Send Verification Link
  socket.on('create-account', async ({ username, email, password }, callback) => {
    const trimmedUser = username ? username.trim() : '';
    const trimmedEmail = email ? email.trim().toLowerCase() : '';
    const key = trimmedUser.toLowerCase();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (!trimmedUser || !trimmedEmail || !password.trim()) {
      return callback({ success: false, error: 'Username, email, and password are all required.' });
    }
    if (!emailRegex.test(trimmedEmail)) {
      return callback({ success: false, error: 'Please enter a valid email address.' });
    }
    if (password.length < 6) {
      return callback({ success: false, error: 'Password must be at least 6 characters long.' });
    }
    if (users[key]) {
      return callback({ success: false, error: 'Username is already taken. Please choose another.' });
    }
    if (emailToUsername[trimmedEmail]) {
      return callback({ success: false, error: 'An account is already associated with this email.' });
    }

    const isPermanentAdmin = key === 'eli';
    const passwordHash = await bcrypt.hash(password, 10);

    users[key] = {
      username: trimmedUser,
      email: trimmedEmail,
      passwordHash,
      isAdmin: isPermanentAdmin,
      isVerified: false,
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(trimmedUser)}`
    };

    emailToUsername[trimmedEmail] = trimmedUser;

    // Generate email verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    verificationTokens[verificationToken] = trimmedUser;

    const verifyLink = `${APP_URL}/verify-email?token=${verificationToken}`;

    try {
      await sendMail({
        to: trimmedEmail,
        subject: 'Verify Your Email - Chromebook Chat',
        html: `
          <div style="font-family: sans-serif; background: #2b2d31; color: #dbdee1; padding: 20px; border-radius: 8px;">
            <h2 style="color: #ffffff;">Welcome to Chromebook Chat!</h2>
            <p>Hello <strong>${trimmedUser}</strong>,</p>
            <p>Thanks for signing up! Please verify your email address to activate your account:</p>
            <p style="margin: 20px 0;">
              <a href="${verifyLink}" style="background: #23a55a; color: white; padding: 10px 18px; text-decoration: none; border-radius: 4px; font-weight: bold; display: inline-block;">Verify Email</a>
            </p>
            <p style="font-size: 0.8em; color: #949ba4;">If you did not create an account, you can safely ignore this email.</p>
          </div>
        `
      });

      callback({
        success: true,
        message: `Account created! Verification email sent to ${trimmedEmail}. Please verify before logging in.`
      });
    } catch (err) {
      console.error(err);
      callback({ success: false, error: 'Failed to send verification email. Please try again.' });
    }
  });

  socket.on('user-connected', (username) => {
    const key = username.toLowerCase();
    socket.username = username;
    socket.join('general');
    
    if (!friendsList[key]) friendsList[key] = [];
    if (!friendRequests[key]) friendRequests[key] = [];
    if (!userGroups[key]) userGroups[key] = [];

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

  socket.on('join-room', ({ target, type }) => {
    let roomName = target;
    if (type === 'dm') {
      roomName = [socket.username, target].sort().join('-');
    }
    socket.join(roomName);
    socket.emit('load-history', messages[roomName] || []);
  });

  socket.on('send-message', ({ target, type, username, text }) => {
    let roomName = target;
    if (type === 'dm') {
      roomName = [username, target].sort().join('-');
    }

    const userKey = username.toLowerCase();
    const sender = users[userKey];
    const cleanText = filterBadWords(text);

    const messageObj = {
      id: Date.now().toString(),
      target,
      targetType: type,
      username,
      avatarUrl: sender ? sender.avatarUrl : '',
      isAdmin: sender ? !!sender.isAdmin : false,
      text: cleanText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reactions: {},
      mentions: []
    };

    const mentions = cleanText.match(/@([a-zA-Z0-9_]+)/g);
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
              text: cleanText 
            });
          }
        }
      });
    }

    if (!messages[roomName]) messages[roomName] = [];
    messages[roomName].push(messageObj);

    io.to(roomName).emit('receive-message', messageObj);
  });

  socket.on('typing', ({ target, type, isTyping }) => {
    let roomName = target;
    if (type === 'dm') {
      roomName = [socket.username, target].sort().join('-');
    }
    socket.to(roomName).emit('user-typing', { username: socket.username, isTyping });
  });

  socket.on('toggle-reaction', ({ messageId, emoji }) => {
    let foundMsg = null;
    let roomKey = null;

    for (const room in messages) {
      const msg = messages[room].find(m => m.id === messageId);
      if (msg) {
        foundMsg = msg;
        roomKey = room;
        break;
      }
    }

    if (foundMsg) {
      if (!foundMsg.reactions[emoji]) {
        foundMsg.reactions[emoji] = [];
      }

      const userIndex = foundMsg.reactions[emoji].indexOf(socket.username);
      if (userIndex > -1) {
        foundMsg.reactions[emoji].splice(userIndex, 1);
      } else {
        foundMsg.reactions[emoji].push(socket.username);
      }

      io.to(roomKey).emit('update-reactions', { messageId, reactions: foundMsg.reactions });
    }
  });

  // Friend Requests Handlers
  socket.on('send-friend-request', ({ targetUsername }, callback) => {
    const senderKey = socket.username?.toLowerCase();
    const targetKey = targetUsername.trim().toLowerCase();

    if (!targetKey || !users[targetKey]) {
      return callback({ success: false, error: 'User does not exist.' });
    }
    if (targetKey === senderKey) {
      return callback({ success: false, error: 'You cannot add yourself.' });
    }
    if (friendsList[senderKey] && friendsList[senderKey].includes(users[targetKey].username)) {
      return callback({ success: false, error: 'User is already your friend.' });
    }

    if (!friendRequests[targetKey]) friendRequests[targetKey] = [];
    
    const alreadySent = friendRequests[targetKey].some(r => r.sender.toLowerCase() === senderKey);
    if (alreadySent) {
      return callback({ success: false, error: 'Friend request already pending.' });
    }

    friendRequests[targetKey].push({ sender: socket.username });

    for (let [id, s] of io.sockets.sockets) {
      if (s.username && s.username.toLowerCase() === targetKey) {
        s.emit('update-friend-requests', friendRequests[targetKey]);
      }
    }

    callback({ success: true, message: `Friend request sent to ${users[targetKey].username}!` });
  });

  socket.on('accept-friend-request', ({ senderUsername }) => {
    const myKey = socket.username?.toLowerCase();
    const senderKey = senderUsername.toLowerCase();

    if (!myKey || !senderKey) return;

    if (!friendsList[myKey]) friendsList[myKey] = [];
    if (!friendsList[senderKey]) friendsList[senderKey] = [];

    const senderActualName = users[senderKey] ? users[senderKey].username : senderUsername;

    if (!friendsList[myKey].includes(senderActualName)) friendsList[myKey].push(senderActualName);
    if (!friendsList[senderKey].includes(socket.username)) friendsList[senderKey].push(socket.username);

    if (friendRequests[myKey]) {
      friendRequests[myKey] = friendRequests[myKey].filter(r => r.sender.toLowerCase() !== senderKey);
    }

    socket.emit('update-friends-list', friendsList[myKey]);
    socket.emit('update-friend-requests', friendRequests[myKey] || []);

    for (let [id, s] of io.sockets.sockets) {
      if (s.username && s.username.toLowerCase() === senderKey) {
        s.emit('update-friends-list', friendsList[senderKey]);
      }
    }
  });

  socket.on('decline-friend-request', ({ senderUsername }) => {
    const myKey = socket.username?.toLowerCase();
    const senderKey = senderUsername.toLowerCase();

    if (!myKey) return;

    if (friendRequests[myKey]) {
      friendRequests[myKey] = friendRequests[myKey].filter(r => r.sender.toLowerCase() !== senderKey);
    }

    socket.emit('update-friend-requests', friendRequests[myKey] || []);
  });

  // Group DM Handler
  socket.on('create-group-dm', ({ members }, callback) => {
    const allMembers = Array.from(new Set([socket.username, ...members]));
    const groupId = 'group-' + Date.now();
    const groupName = allMembers.join(', ');

    const groupObj = { id: groupId, name: groupName, members: allMembers };
    groupDms[groupId] = groupObj;

    allMembers.forEach(mem => {
      const key = mem.toLowerCase();
      if (!userGroups[key]) userGroups[key] = [];
      userGroups[key].push(groupId);
    });

    for (let [id, s] of io.sockets.sockets) {
      if (s.username && allMembers.some(m => m.toLowerCase() === s.username.toLowerCase())) {
        s.join(groupId);
        const userKey = s.username.toLowerCase();
        const persistentGroupObjs = (userGroups[userKey] || []).map(gId => groupDms[gId]).filter(Boolean);
        s.emit('update-groups-list', persistentGroupObjs);
      }
    }

    callback({ success: true, group: groupObj });
  });

  // Channel Management Handlers
  socket.on('create-channel', ({ channelName }, callback) => {
    const currentUser = users[socket.username?.toLowerCase()];
    if (!currentUser || !currentUser.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Admin access required.' });
    }

    const cleanName = channelName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!cleanName) return callback({ success: false, error: 'Channel name required.' });
    if (channels.includes(cleanName)) return callback({ success: false, error: 'Channel already exists.' });

    channels.push(cleanName);
    messages[cleanName] = [];

    io.emit('update-channels', channels);
    callback({ success: true, channelName: cleanName });
  });

  socket.on('delete-channel', ({ channelName }, callback) => {
    const currentUser = users[socket.username?.toLowerCase()];
    if (!currentUser || !currentUser.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Admin access required.' });
    }
    if (channelName === 'general') {
      return callback({ success: false, error: 'Cannot delete default general channel.' });
    }

    const index = channels.indexOf(channelName);
    if (index > -1) {
      channels.splice(index, 1);
      delete messages[channelName];
      io.emit('update-channels', channels);
      callback({ success: true });
    } else {
      callback({ success: false, error: 'Channel not found.' });
    }
  });

  socket.on('clear-room-messages', ({ target, type }, callback) => {
    const currentUser = users[socket.username?.toLowerCase()];
    if (!currentUser || !currentUser.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Admin access required.' });
    }

    let roomName = target;
    if (type === 'dm') {
      roomName = [socket.username, target].sort().join('-');
    }

    messages[roomName] = [];
    io.to(roomName).emit('load-history', []);
    callback({ success: true });
  });

  // User Profile & Admin Panel Handlers
  socket.on('update-avatar', ({ avatarUrl }, callback) => {
    const myKey = socket.username?.toLowerCase();
    if (myKey && users[myKey]) {
      users[myKey].avatarUrl = avatarUrl;
      callback({ success: true, avatarUrl });
    } else {
      callback({ success: false, error: 'User not found.' });
    }
  });

  socket.on('request-username-change', ({ requestedUsername }, callback) => {
    const targetKey = requestedUsername.trim().toLowerCase();

    if (!targetKey) return callback({ success: false, error: 'Username required.' });
    if (users[targetKey]) return callback({ success: false, error: 'Username already taken.' });

    usernameRequests.push({
      id: Date.now().toString(),
      currentUsername: socket.username,
      requestedUsername: requestedUsername.trim()
    });

    callback({ success: true, message: 'Username change requested successfully.' });
  });

  socket.on('get-all-users', (callback) => {
    const currentUser = users[socket.username?.toLowerCase()];
    if (!currentUser || !currentUser.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Admin access required.' });
    }

    const userList = Object.values(users).map(u => ({
      username: u.username,
      email: u.email,
      isAdmin: !!u.isAdmin,
      isVerified: !!u.isVerified
    }));

    callback({
      success: true,
      users: userList,
      usernameRequests
    });
  });

  socket.on('resolve-username-request', ({ requestId, approve }, callback) => {
    const currentUser = users[socket.username?.toLowerCase()];
    if (!currentUser || !currentUser.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Admin access required.' });
    }

    const index = usernameRequests.findIndex(r => r.id === requestId);
    if (index === -1) return callback({ success: false, error: 'Request not found.' });

    const req = usernameRequests.splice(index, 1)[0];

    if (approve) {
      const oldKey = req.currentUsername.toLowerCase();
      const newKey = req.requestedUsername.toLowerCase();

      if (users[oldKey]) {
        users[newKey] = {
          ...users[oldKey],
          username: req.requestedUsername
        };
        emailToUsername[users[oldKey].email] = req.requestedUsername;
        delete users[oldKey];

        for (let [id, s] of io.sockets.sockets) {
          if (s.username && s.username.toLowerCase() === oldKey) {
            s.username = req.requestedUsername;
            s.emit('username-updated', { newUsername: req.requestedUsername });
          }
        }
      }
    }

    callback({ success: true, message: approve ? 'Approved request.' : 'Rejected request.' });
  });

  socket.on('toggle-admin-status', ({ targetUsername, makeAdmin }, callback) => {
    const currentUser = users[socket.username?.toLowerCase()];
    if (!currentUser || !currentUser.isAdmin) {
      return callback({ success: false, error: 'Unauthorized: Admin access required.' });
    }

    const targetKey = targetUsername.toLowerCase();
    if (!users[targetKey]) {
      return callback({ success: false, error: 'User not found.' });
    }

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
