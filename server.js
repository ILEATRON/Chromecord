const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-chat-key-change-in-prod';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const io = new Server(server, {
  maxHttpBufferSize: 1e8 
});

app.use(express.static('public'));
app.use(express.json());

// In-memory user store
const users = {};

// Helper: Seed initial admin user
(async () => {
  const eliPasswordHash = await bcrypt.hash('4Peasinapod!', 10);
  users['eli'] = { 
    email: 'admin@example.com',
    username: 'Eli', 
    passwordHash: eliPasswordHash, 
    isAdmin: true,
    isVerified: true,
    avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=Eli' 
  };
})();

const channels = ['general'];
const messages = { general: [] };
const friendRequests = {};
const friendsList = {};
const usernameRequests = [];
const groupDms = {};
const userGroups = {};

const BANNED_WORDS = [
  'gay', 'lesbian', 'homo', 'faggot', 'fagot', 'fag', 'fags', 'faggots', 'fagots',
  'nigger', 'niggers', 'nigga', 'niggas', 'niggah', 'niggahs', 'nigg3r', 'nigg4', 'n1gger', 'n1gga', 'niga', 'niger',
  'fuck', 'fucker', 'fuckin', 'fucking', 'fucked', 'fuckface', 'fuckhead', 'motherfucker',
  'shit', 'shits', 'shitting', 'shitty', 'bullshit', 'ass', 'asshole', 'assholes', 'dumbass', 'jackass',
  'bitch', 'bitches', 'bitchy', 'bastard', 'bastards', 'cunt', 'cunts', 'dick', 'dicks', 'dickhead',
  'cock', 'cocks', 'cocksucker', 'jew', 'hitler', 'hilter', 'pussy', 'pussies', 'slut', 'sluts',
  'whore', 'whores', 'prick', 'pricks', 'piss', 'pissed'
];

const profanityRegex = new RegExp(`\\b(${BANNED_WORDS.join('|')})\\b`, 'gi');

function filterBadWords(text) {
  if (!text) return text;
  let cleanText = text.replace(profanityRegex, (match) => '*'.repeat(match.length));
  cleanText = cleanText.replace(/\b(f[u\*k@!1]+ck|sh[!1i*]t|b[!1i*]tch|a[$\*s]{2,}|c[u\*k@!1]+nt)\b/gi, (match) => '*'.repeat(match.length));
  return cleanText;
}

// -------------------------------------------------------------
// Web-Based HTTP API Email Sender (No Install / pure fetch)
// -------------------------------------------------------------
async function sendWebEmail(toEmail, subject, htmlContent) {
  // If you use a free API like Resend, SendGrid, or ElasticEmail:
  if (process.env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'Chromebook Chat <onboarding@resend.dev>',
          to: toEmail,
          subject: subject,
          html: htmlContent
        })
      });
      return true;
    } catch (err) {
      console.error('Web Email API error:', err);
      return false;
    }
  }

  // Fallback / Web Console Output (Works out of the box with zero setup)
  console.log(`\n================ WEB EMAIL SENT ================`);
  console.log(`TO: ${toEmail}`);
  console.log(`SUBJECT: ${subject}`);
  console.log(`BODY:\n${htmlContent}`);
  console.log(`================================================\n`);
  return true;
}

// -------------------------------------------------------------
// Web Verification Route
// -------------------------------------------------------------
app.get('/verify-email', (req, res) => {
  const { token } = req.query;
  const userKey = Object.keys(users).find(k => users[k].verificationToken === token);

  if (!userKey) {
    return res.status(400).send(`
      <div style="font-family:sans-serif; text-align:center; padding: 40px; background:#313338; color:#f23f43; height:100vh;">
        <h2>Invalid or expired verification link.</h2>
      </div>
    `);
  }

  users[userKey].isVerified = true;
  delete users[userKey].verificationToken;

  res.send(`
    <div style="font-family:sans-serif; text-align:center; padding: 40px; background:#313338; color:#23a55a; height:100vh;">
      <h2>Email verified successfully!</h2>
      <p style="color:#dbdee1;">You can close this tab and log in to Chromebook Chat.</p>
    </div>
  `);
});

// -------------------------------------------------------------
// Socket.IO Handlers
// -------------------------------------------------------------
io.on('connection', (socket) => {

  // Auto Login Verification
  socket.on('verify-token', ({ token }, callback) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const key = decoded.username.toLowerCase();
      
      if (!users[key]) {
        return callback({ success: false, error: 'User account no longer exists.' });
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

  // Account Registration with Email + Username + Password
  socket.on('create-account', async ({ email, username, password }, callback) => {
    const cleanEmail = email ? email.trim().toLowerCase() : '';
    const trimmedUser = username ? username.trim() : '';
    const key = trimmedUser.toLowerCase();

    if (!cleanEmail || !trimmedUser || !password.trim()) {
      return callback({ success: false, error: 'Email, username, and password are required.' });
    }
    if (password.length < 6) {
      return callback({ success: false, error: 'Password must be at least 6 characters long.' });
    }

    // Check email uniqueness
    const emailExists = Object.values(users).some(u => u.email && u.email.toLowerCase() === cleanEmail);
    if (emailExists) {
      return callback({ success: false, error: 'An account with that email already exists.' });
    }

    // Check username uniqueness
    if (users[key]) {
      return callback({ success: false, error: 'Username is already taken. Please choose another.' });
    }

    const isPermanentAdmin = key === 'eli';
    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    users[key] = {
      email: cleanEmail,
      username: trimmedUser,
      passwordHash,
      isVerified: isPermanentAdmin, // Admin verified automatically
      verificationToken,
      isAdmin: isPermanentAdmin,
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(trimmedUser)}`
    };

    const verifyUrl = `${BASE_URL}/verify-email?token=${verificationToken}`;
    const emailHtml = `<p>Hello <b>${trimmedUser}</b>,</p><p>Click below to verify your email address:</p><a href="${verifyUrl}">${verifyUrl}</a>`;

    await sendWebEmail(cleanEmail, 'Verify your Chromebook Chat account', emailHtml);

    callback({
      success: true,
      message: 'Account created! Please check your email inbox to click the verification link before logging in.'
    });
  });

  // Account Login (Username or Email)
  socket.on('login-account', async ({ identifier, password }, callback) => {
    const input = identifier.trim().toLowerCase();
    
    // Search by username key or email property
    const userKey = Object.keys(users).find(k => k === input || (users[k].email && users[k].email.toLowerCase() === input));
    
    if (!userKey) {
      return callback({ success: false, error: 'User does not exist.' });
    }

    const user = users[userKey];

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      return callback({ success: false, error: 'Invalid password.' });
    }

    if (!user.isVerified) {
      return callback({ success: false, error: 'Account not verified. Please click the link sent to your email.' });
    }

    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    socket.username = user.username;
    callback({
      success: true,
      token,
      username: user.username,
      avatarUrl: user.avatarUrl,
      isAdmin: user.username.toLowerCase() === 'eli' ? true : !!user.isAdmin
    });
  });

  // Password Reset Email Request
  socket.on('request-password-reset', async ({ email }, callback) => {
    const cleanEmail = email.trim().toLowerCase();
    const userKey = Object.keys(users).find(k => users[k].email && users[k].email.toLowerCase() === cleanEmail);

    if (!userKey) {
      return callback({ success: false, error: 'No account found with that email address.' });
    }

    const resetToken = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8-char web code
    users[userKey].resetPasswordToken = resetToken;
    users[userKey].resetPasswordExpires = Date.now() + 3600000; // 1 hour

    const emailHtml = `<p>You requested a password reset for Chromebook Chat.</p><p>Your reset code is: <h2>${resetToken}</h2></p>`;
    await sendWebEmail(cleanEmail, 'Password Reset Code', emailHtml);

    callback({ success: true, message: 'Password reset code has been sent to your email address!' });
  });

  // Submit Password Reset
  socket.on('submit-password-reset', async ({ resetToken, newPassword }, callback) => {
    const cleanToken = resetToken.trim().toUpperCase();
    const userKey = Object.keys(users).find(
      k => users[k].resetPasswordToken === cleanToken && users[k].resetPasswordExpires > Date.now()
    );

    if (!userKey) {
      return callback({ success: false, error: 'Invalid or expired reset code.' });
    }

    if (!newPassword || newPassword.trim().length < 6) {
      return callback({ success: false, error: 'New password must be at least 6 characters long.' });
    }

    users[userKey].passwordHash = await bcrypt.hash(newPassword, 10);
    delete users[userKey].resetPasswordToken;
    delete users[userKey].resetPasswordExpires;

    callback({ success: true, message: 'Password reset successfully! You can now log in.' });
  });

  // Socket chat handlers remain intact below
  socket.on('user-connected', (username) => {
    const key = username.toLowerCase();
    socket.username = username;
    socket.join('general');
    
    if (!friendsList[key]) friendsList[key] = [];
    if (!friendRequests[key]) friendRequests[key] = [];
    if (!userGroups[key]) userGroups[key] = [];

    if (key === 'eli') {
      if (users[key]) users[key].isAdmin = true;
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
            s.emit('user-pinged', { sender: username, target, roomName: target, text: cleanText });
          }
        }
      });
    }

    if (!messages[roomName]) messages[roomName] = [];
    messages[roomName].push(messageObj);

    io.to(roomName).emit('receive-message', messageObj);
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
