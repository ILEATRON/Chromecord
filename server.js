const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// CRITICAL: Explicitly serve static assets from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// In-memory message store
const messages = {}; // channelId -> array of messages

io.on('connection', (socket) => {
  // Join a room/channel
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

  // Handle Standard Text Messages
  socket.on('send_message', (text) => {
    if (!text || !text.trim() || !socket.channelId) return;

    const msg = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: 'text',
      sender: socket.username,
      text: text.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    messages[socket.channelId].push(msg);
    io.to(socket.channelId).emit('new_message', msg);
  });

  // Handle Poll Creation
  socket.on('create_poll', ({ question, options }) => {
    if (!question || !Array.isArray(options) || options.length < 2 || !socket.channelId) return;

    const pollMsg = {
      id: `poll_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: 'poll',
      sender: socket.username,
      question: question.trim(),
      options: options.map((opt, idx) => ({
        id: idx,
        text: opt.trim(),
        votes: [] // Array of usernames who voted
      })),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    messages[socket.channelId].push(pollMsg);
    io.to(socket.channelId).emit('new_message', pollMsg);
  });

  // Handle Voting
  socket.on('cast_vote', ({ pollId, optionId }) => {
    const channelMsgs = messages[socket.channelId];
    if (!channelMsgs) return;

    const poll = channelMsgs.find(m => m.id === pollId && m.type === 'poll');
    if (!poll) return;

    const voter = socket.username;

    // Check if user already voted on this specific option (toggle off)
    const targetOption = poll.options.find(o => o.id === optionId);
    const alreadyVotedTarget = targetOption && targetOption.votes.includes(voter);

    // Remove vote from all options (one vote per user restriction)
    poll.options.forEach(opt => {
      opt.votes = opt.votes.filter(u => u !== voter);
    });

    // Add vote if it wasn't already selected
    if (!alreadyVotedTarget && targetOption) {
      targetOption.votes.push(voter);
    }

    // Broadcast updated poll status
    io.to(socket.channelId).emit('poll_updated', {
      pollId: poll.id,
      options: poll.options
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
