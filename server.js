const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory data stores
const onlineUsers = new Map(); // socket.id -> username
const userSockets = new Map(); // username.toLowerCase() -> socket.id
const friendsStore = new Map(); // username.toLowerCase() -> Set of friend usernames (normalized)
const pendingRequests = new Map(); // targetUsername.toLowerCase() -> Array of sender usernames

const ACCESS_PASSCODE = '1234';
const ADMIN_PASSCODE = 'admin123';

function getFriendsList(username) {
  const key = username.toLowerCase();
  if (!friendsStore.has(key)) friendsStore.set(key, new Set());
  return Array.from(friendsStore.get(key));
}

function getPendingRequests(username) {
  const key = username.toLowerCase();
  if (!pendingRequests.has(key)) pendingRequests.set(key, []);
  return pendingRequests.get(key);
}

function notifyUserFriendsUpdate(username) {
  const sockId = userSockets.get(username.toLowerCase());
  if (sockId) {
    const friends = getFriendsList(username);
    io.to(sockId).emit('update-friends-list', friends);
  }
}

function notifyUserRequestsUpdate(username) {
  const sockId = userSockets.get(username.toLowerCase());
  if (sockId) {
    const requests = getPendingRequests(username);
    io.to(sockId).emit('update-friend-requests', requests);
  }
}

io.on('connection', (socket) => {

  socket.on('verify-code', ({ username, code }, callback) => {
    const trimmedUser = username ? username.trim() : '';

    if (!trimmedUser) {
      return callback({ success: false, error: 'Username cannot be empty.' });
    }

    if (code === ACCESS_PASSCODE || code === ADMIN_PASSCODE) {
      const isAdmin = (code === ADMIN_PASSCODE);
      socket.username = trimmedUser;
      socket.isAdmin = isAdmin;

      callback({
        success: true,
        username: trimmedUser,
        isAdmin: isAdmin
      });
    } else {
      callback({ success: false, error: 'Invalid access passcode.' });
    }
  });

  socket.on('user-connected', (username) => {
    socket.username = username;
    const lowerUser = username.toLowerCase();
    
    onlineUsers.set(socket.id, username);
    userSockets.set(lowerUser, socket.id);

    io.emit('update-online-users', Array.from(new Set(onlineUsers.values())));

    // Send initial user relationship data
    socket.emit('update-friends-list', getFriendsList(username));
    socket.emit('update-friend-requests', getPendingRequests(username));
  });

  // Handle sending a friend request
  socket.on('send-friend-request', ({ targetUsername }, callback) => {
    const sender = socket.username;
    const target = targetUsername ? targetUsername.trim() : '';
    const lowerSender = sender.toLowerCase();
    const lowerTarget = target.toLowerCase();

    if (!target) {
      return callback({ success: false, error: 'Please enter a username.' });
    }
    if (lowerSender === lowerTarget) {
      return callback({ success: false, error: 'You cannot add yourself.' });
    }

    // Check if user is registered online/known
    const targetExists = Array.from(onlineUsers.values()).some(u => u.toLowerCase() === lowerTarget);
    if (!targetExists) {
      return callback({ success: false, error: 'User not found or offline.' });
    }

    // Check existing friends
    const senderFriends = getFriendsList(sender);
    if (senderFriends.some(f => f.toLowerCase() === lowerTarget)) {
      return callback({ success: false, error: 'User is already your friend.' });
    }

    // Check existing incoming/outgoing request
    const targetReqs = getPendingRequests(target);
    if (targetReqs.some(r => r.toLowerCase() === lowerSender)) {
      return callback({ success: false, error: 'Friend request already sent.' });
    }

    targetReqs.push(sender);
    pendingRequests.set(lowerTarget, targetReqs);

    notifyUserRequestsUpdate(target);
    callback({ success: true, message: `Friend request sent to ${target}!` });
  });

  // Handle responding to a friend request (accept/decline)
  socket.on('respond-friend-request', ({ senderUsername, accept }) => {
    const recipient = socket.username;
    const lowerRecipient = recipient.toLowerCase();
    const lowerSender = senderUsername.toLowerCase();

    let reqs = getPendingRequests(recipient);
    reqs = reqs.filter(r => r.toLowerCase() !== lowerSender);
    pendingRequests.set(lowerRecipient, reqs);

    if (accept) {
      // Add mutual friendship
      if (!friendsStore.has(lowerRecipient)) friendsStore.set(lowerRecipient, new Set());
      if (!friendsStore.has(lowerSender)) friendsStore.set(lowerSender, new Set());

      friendsStore.get(lowerRecipient).add(senderUsername);
      friendsStore.get(lowerSender).add(recipient);

      notifyUserFriendsUpdate(senderUsername);
      notifyUserFriendsUpdate(recipient);
    }

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
    socket.currentRoom = roomName;
  });

  socket.on('send-message', ({ target, type, username, text }) => {
    if (!text || !text.trim()) return;

    let roomName = (type === 'dm')
      ? [username.toLowerCase(), target.toLowerCase()].sort().join('--dm--')
      : target;

    const messageData = {
      username,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      target,
      type
    };

    io.to(roomName).emit('receive-message', messageData);
  });

  socket.on('typing', ({ target, type, isTyping }) => {
    let roomName = (type === 'dm')
      ? [socket.username.toLowerCase(), target.toLowerCase()].sort().join('--dm--')
      : target;

    socket.to(roomName).emit('user-typing', {
      username: socket.username,
      isTyping
    });
  });

  socket.on('disconnect', () => {
    if (socket.id) {
      const user = onlineUsers.get(socket.id);
      if (user) userSockets.delete(user.toLowerCase());
      onlineUsers.delete(socket.id);
      io.emit('update-online-users', Array.from(new Set(onlineUsers.values())));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
