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

// In-memory databases
const users = {};
const channels = ['general'];
const messages = { general: [] };
const friendRequests = {};
const friendsList = {};
const usernameRequests = [];
const groupDms = {};
const userGroups = {};

// Seed default admin account
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

// Pure Web Email Delivery (Uses standard HTTP fetch API or outputs to terminal)
async function sendWebEmail(toEmail, subject, htmlContent) {
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
      console.error('Web Email API Error:', err);
      return false;
    }
  }

  // Console Fallback for local web development
  console.log(`\n================ OUTGOING EMAIL ================`);
  console.log(`TO: ${toEmail}`);
  console.log(`SUBJECT: ${subject}`);
  console.log(`BODY:\n${htmlContent}`);
  console.log(`================================================\n`);
  return true;
}

// HTTP Route to Handle Email Verification Links
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

// Socket.IO Logic
io.on('connection', (socket) => {

  // Session Token Auto-login Verification
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

  // Create Account with Email, Username, and Password
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

    const emailExists = Object.values(users).some(u => u.email && u.email.toLowerCase() === cleanEmail);
    if (emailExists) {
      return callback({ success: false, error: 'An account with that email address already exists.' });
    }

    if (users[key]) {
      return callback({ success: false, error: 'Username is already taken.' });
    }

    const isPermanentAdmin = key === 'eli';
    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    users[key] = {
      email: cleanEmail,
      username: trimmedUser,
      passwordHash,
      isVerified: isPermanentAdmin,
      verificationToken,
      isAdmin: isPermanentAdmin,
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(trimmedUser)}`
    };

    const verifyUrl = `${BASE_URL}/verify-email?token=${verificationToken}`;
    const emailHtml = `<p>Hello <b>${trimmedUser}</b>,</p><p>Please click the link below to verify your email address:</p><a href="${verifyUrl}">${verifyUrl}</a>`;

    await sendWebEmail(cleanEmail, 'Verify your Chromebook Chat account', emailHtml);

    callback({
      success: true,
      message: 'Account created! Please check your email to verify your account before logging in.'
    });
  });

  // Login Account (Accepts Username or Email)
  socket.on('login-account', async ({ identifier, password }, callback) => {
    const input = identifier.trim().toLowerCase();
    const userKey = Object.keys(users).find(k => k === input || (users[k].email && users[k].email.toLowerCase() === input));
    
    if (!userKey) {
      return callback({ success: false, error: 'Account does not exist.' });
    }

    const user = users[userKey];

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      return callback({ success: false, error: 'Invalid password.' });
    }

    if (!user.isVerified) {
      return callback({ success: false, error: 'Account not verified. Please check your email for the verification link.' });
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

  // Request Password Reset Code
  socket.on('request-password-reset', async ({ email }, callback) => {
    const cleanEmail = email.trim().toLowerCase();
    const userKey = Object.keys(users).find(k => users[k].email && users[k].email.toLowerCase() === cleanEmail);

    if (!userKey) {
      return callback({ success: false, error: 'No account found with that email address.' });
    }

    const resetToken = crypto.randomBytes(4).toString('hex').toUpperCase();
    users[userKey].resetPasswordToken = resetToken;
    users[userKey].resetPasswordExpires = Date.now() + 3600000;

    const emailHtml = `<p>You requested a password reset for Chromebook Chat.</p><p>Your reset code is: <h2>${resetToken}</h2></p>`;
    await sendWebEmail(cleanEmail, 'Password Reset Code', emailHtml);

    callback({ success: true, message: 'Password reset code sent to your email address!' });
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
      return callback({ success: false, error: 'Password must be at least 6 characters long.' });
    }

    users[userKey].passwordHash = await bcrypt.hash(newPassword, 10);
    delete users[userKey].resetPasswordToken;
    delete users[userKey].resetPasswordExpires;

    callback({ success: true, message: 'Password reset successfully! You can now log in.' });
  });

  // Connected socket setup
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

  socket.on('create-channel', (channelName) => {
    const key = socket.username ? socket.username.toLowerCase() : '';
    const user = users[key];
    const isPermanentAdmin = key === 'eli';
    if (!user || (!user.isAdmin && !isPermanentAdmin)) return;

    const cleanName = channelName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (cleanName && !channels.includes(cleanName)) {
      channels.push(cleanName);
      messages[cleanName] = [];
      io.emit('update-channels', channels);
    }
  });

  socket.on('delete-channel', (channelName) => {
    const key = socket.username ? socket.username.toLowerCase() : '';
    const user = users[key];
    const isPermanentAdmin = key === 'eli';
    if (!user || (!user.isAdmin && !isPermanentAdmin)) return;

    if (channelName === 'general') return;
    const index = channels.indexOf(channelName);
    if (index !== -1) {
      channels.splice(index, 1);
      delete messages[channelName];
      io.emit('update-channels', channels);
    }
  });

  socket.on('clear-chat', (target) => {
    const key = socket.username ? socket.username.toLowerCase() : '';
    const user = users[key];
    const isPermanentAdmin = key === 'eli';
    if (!user || (!user.isAdmin && !isPermanentAdmin)) return;

    messages[target] = [];
    io.to(target).emit('load-history', []);
  });

  socket.on('request-username-change', ({ requestedName }) => {
    const cleanName = requestedName.trim();
    if (!cleanName) return;
    const existing = usernameRequests.find(r => r.currentName.toLowerCase() === socket.username.toLowerCase());
    if (!existing) {
      usernameRequests.push({ currentName: socket.username, requestedName: cleanName });
    }
    io.emit('update-username-requests', usernameRequests);
  });

  socket.on('resolve-username-request', ({ currentName, requestedName, approved }) => {
    const key = socket.username ? socket.username.toLowerCase() : '';
    const user = users[key];
    const isPermanentAdmin = key === 'eli';
    if (!user || (!user.isAdmin && !isPermanentAdmin)) return;

    const idx = usernameRequests.findIndex(r => r.currentName === currentName && r.requestedName === requestedName);
    if (idx !== -1) usernameRequests.splice(idx, 1);

    if (approved) {
      const oldKey = currentName.toLowerCase();
      const newKey = requestedName.toLowerCase();

      if (users[oldKey] && !users[newKey]) {
        users[newKey] = { ...users[oldKey], username: requestedName };
        delete users[oldKey];

        for (let [id, s] of io.sockets.sockets) {
          if (s.username === currentName) {
            s.username = requestedName;
            s.emit('username-changed', requestedName);
          }
        }
      }
    }
    io.emit('update-username-requests', usernameRequests);
  });

  socket.on('toggle-admin', ({ targetUser }) => {
    const key = socket.username ? socket.username.toLowerCase() : '';
    const user = users[key];
    const isPermanentAdmin = key === 'eli';
    if (!user || (!user.isAdmin && !isPermanentAdmin)) return;

    const targetKey = targetUser.toLowerCase();
    if (targetKey === 'eli') return;

    if (users[targetKey]) {
      users[targetKey].isAdmin = !users[targetKey].isAdmin;
      for (let [id, s] of io.sockets.sockets) {
        if (s.username.toLowerCase() === targetKey) {
          s.emit('role-updated', { isAdmin: users[targetKey].isAdmin });
        }
      }
    }
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

  socket.on('add-reaction', ({ messageId, roomName, emoji }) => {
    const roomMsgs = messages[roomName];
    if (roomMsgs) {
      const msg = roomMsgs.find(m => m.id === messageId);
      if (msg) {
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        if (!msg.reactions[emoji].includes(socket.username)) {
          msg.reactions[emoji].push(socket.username);
          io.to(roomName).emit('reaction-updated', { messageId, reactions: msg.reactions });
        }
      }
    }
  });

  socket.on('typing', ({ target, type, isTyping }) => {
    let roomName = target;
    if (type === 'dm') {
      roomName = [socket.username, target].sort().join('-');
    }
    socket.to(roomName).emit('user-typing', { username: socket.username, isTyping });
  });

  socket.on('send-friend-request', (targetUser) => {
    const targetKey = targetUser.toLowerCase();
    const myKey = socket.username.toLowerCase();

    if (users[targetKey] && targetKey !== myKey) {
      if (!friendRequests[targetKey]) friendRequests[targetKey] = [];
      if (!friendRequests[targetKey].includes(socket.username) && !friendsList[myKey]?.includes(targetUser)) {
        friendRequests[targetKey].push(socket.username);
        for (let [id, s] of io.sockets.sockets) {
          if (s.username.toLowerCase() === targetKey) {
            s.emit('update-friend-requests', friendRequests[targetKey]);
          }
        }
      }
    }
  });

  socket.on('accept-friend-request', (requester) => {
    const myKey = socket.username.toLowerCase();
    const reqKey = requester.toLowerCase();

    if (!friendsList[myKey]) friendsList[myKey] = [];
    if (!friendsList[reqKey]) friendsList[reqKey] = [];

    if (!friendsList[myKey].includes(requester)) friendsList[myKey].push(requester);
    if (!friendsList[reqKey].includes(socket.username)) friendsList[reqKey].push(socket.username);

    if (friendRequests[myKey]) {
      friendRequests[myKey] = friendRequests[myKey].filter(u => u !== requester);
    }

    socket.emit('update-friends-list', friendsList[myKey]);
    socket.emit('update-friend-requests', friendRequests[myKey]);

    for (let [id, s] of io.sockets.sockets) {
      if (s.username.toLowerCase() === reqKey) {
        s.emit('update-friends-list', friendsList[reqKey]);
      }
    }
  });

  socket.on('decline-friend-request', (requester) => {
    const myKey = socket.username.toLowerCase();
    if (friendRequests[myKey]) {
      friendRequests[myKey] = friendRequests[myKey].filter(u => u !== requester);
      socket.emit('update-friend-requests', friendRequests[myKey]);
    }
  });

  socket.on('create-group-dm', ({ groupName, members }) => {
    const groupId = 'group-' + Date.now();
    const allMembers = Array.from(new Set([...members, socket.username]));
    
    groupDms[groupId] = { id: groupId, name: groupName, members: allMembers };

    allMembers.forEach(member => {
      const key = member.toLowerCase();
      if (!userGroups[key]) userGroups[key] = [];
      userGroups[key].push(groupId);

      for (let [id, s] of io.sockets.sockets) {
        if (s.username && s.username.toLowerCase() === key) {
          s.join(groupId);
          const persistentGroupObjs = userGroups[key].map(gid => groupDms[gid]).filter(Boolean);
          s.emit('update-groups-list', persistentGroupObjs);
        }
      }
    });
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
