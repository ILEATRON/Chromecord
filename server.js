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

// Expanded profanity & slur dictionary
const BANNED_WORDS = [
  // Direct requested terms & variations
  'gay', 'lesbian', 'homo',
  'faggot', 'fagot', 'fag', 'fags', 'faggots', 'fagots',
  'nigger', 'niggers', 'nigga', 'niggas', 'niggah', 'niggahs', 'nigg3r', 'nigg4', 'n1gger', 'n1gga',

  // Common cuss words & profanities
  'fuck', 'fucker', 'fuckin', 'fucking', 'fucked', 'fuckface', 'fuckhead', 'motherfucker', 'chink',
  'shit', 'shits', 'shitting', 'shitty', 'bullshit',
  'ass', 'asshole', 'assholes', 'dumbass', 'jackass',
  'bitch', 'bitches', 'bitchy',
  'bastard', 'bastards',
  'cunt', 'cunts',
  'dick', 'dicks', 'dickhead',
  'cock', 'cocks', 'cocksucker',
  'pussy', 'pussies',
  'slut', 'sluts',
  'whore', 'whores',
  'prick', 'pricks',
  'bastard', 'piss', 'pissed'
];

// RegEx to catch exact words and common character replacements (@, $, !, 0, 1, 3)
const profanityRegex = new RegExp(`\\b(${BANNED_WORDS.join('|')})\\b`, 'gi');

function filterBadWords(text) {
  if (!text) return text;
  
  // Replace base words
  let cleanText = text.replace(profanityRegex, (match) => '*'.repeat(match.length));

  // Catch leetspeak replacements for key terms (e.g., f*ck, sh!t, b!tch, a$$)
  cleanText = cleanText.replace(/\b(f[u\*k@!1]+ck|sh[!1i*]t|b[!1i*]tch|a[$\*s]{2,}|c[u\*k@!1]+nt)\b/gi, (match) => '*'.repeat(match.length));

  return cleanText;
}

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

    // Filter text for profanity and cuss words
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
    const myKey = socket.username.toLowerCase();
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
    const myKey = socket.username?.toLowerCase();
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
      isAdmin: !!u.isAdmin
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
