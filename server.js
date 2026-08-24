const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

// In-memory data store (replace with database as needed)
const messages = {}; // channelId -> array of message objects

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Join a channel
  socket.on('join_channel', ({ username, channelId }) => {
    socket.username = username || 'Anonymous';
    socket.channelId = channelId || 'general';
    socket.join(socket.channelId);

    if (!messages[socket.channelId]) {
      messages[socket.channelId] = [];
    }

    // Send history to joining user
    socket.emit('message_history', messages[socket.channelId]);
  });

  // Standard Chat Message
  socket.on('send_message', (text) => {
    if (!text.trim() || !socket.channelId) return;

    const msg = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: 'text',
      sender: socket.username,
      text: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    messages[socket.channelId].push(msg);
    io.to(socket.channelId).emit('new_message', msg);
  });

  // Create Poll Message
  socket.on('create_poll', ({ question, options }) => {
    if (!question || !Array.isArray(options) || options.length < 2 || !socket.channelId) return;

    const pollMsg = {
      id: `poll_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: 'poll',
      sender: socket.username,
      question: question,
      options: options.map((opt, idx) => ({
        id: idx,
        text: opt,
        votes: [] // Stores usernames who voted for this option
      })),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    messages[socket.channelId].push(pollMsg);
    io.to(socket.channelId).emit('new_message', pollMsg);
  });

  // Cast or Toggle Vote
  socket.on('cast_vote', ({ pollId, optionId }) => {
    const channelMsgs = messages[socket.channelId];
    if (!channelMsgs) return;

    const poll = channelMsgs.find(m => m.id === pollId && m.type === 'poll');
    if (!poll) return;

    const voter = socket.username;

    // Check if user already voted on this exact option (toggle off)
    const targetOption = poll.options.find(o => o.id === optionId);
    const alreadyVotedTarget = targetOption && targetOption.votes.includes(voter);

    // Remove user vote from all options (one vote per user restriction)
    poll.options.forEach(opt => {
      opt.votes = opt.votes.filter(u => u !== voter);
    });

    // If they hadn't voted for this option yet, add their vote
    if (!alreadyVotedTarget && targetOption) {
      targetOption.votes.push(voter);
    }

    // Broadcast updated poll state to room
    io.to(socket.channelId).emit('poll_updated', {
      pollId: poll.id,
      options: poll.options
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
