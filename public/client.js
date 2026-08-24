const socket = io();

// Prompts for username or defaults
const username = prompt("Enter your username:") || "Anonymous";
const channelId = "general";

const chatMessages = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const messageInput = document.getElementById("message-input");

// Modal Elements
const pollModal = document.getElementById("poll-modal");
const openPollModalBtn = document.getElementById("open-poll-modal-btn");
const closeModalBtn = document.getElementById("close-modal-btn");
const pollForm = document.getElementById("poll-form");
const addOptionBtn = document.getElementById("add-option-btn");
const pollOptionsContainer = document.getElementById("poll-options-container");

// Join Room
socket.emit("join_channel", { username, channelId });

// Send Standard Text Message
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (messageInput.value.trim()) {
    socket.emit("send_message", messageInput.value.trim());
    messageInput.value = "";
  }
});

// Message Stream Handlers
socket.on("message_history", (messages) => {
  chatMessages.innerHTML = "";
  messages.forEach(renderMessage);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

socket.on("new_message", (msg) => {
  renderMessage(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// Update Poll UI in Real-Time
socket.on("poll_updated", ({ pollId, options }) => {
  const pollCard = document.querySelector(`[data-poll-id="${pollId}"]`);
  if (!pollCard) return;

  const totalVotes = options.reduce((sum, opt) => sum + opt.votes.length, 0);

  options.forEach((opt) => {
    const optionRow = pollCard.querySelector(`[data-option-id="${opt.id}"]`);
    if (!optionRow) return;

    const percent = totalVotes > 0 ? Math.round((opt.votes.length / totalVotes) * 100) : 0;
    const isVotedByMe = opt.votes.includes(username);

    optionRow.querySelector(".poll-progress-bar").style.width = `${percent}%`;
    optionRow.querySelector(".vote-count").textContent = `${opt.votes.length} (${percent}%)`;
    optionRow.classList.toggle("voted", isVotedByMe);
  });
});

// Render Elements to Screen
function renderMessage(msg) {
  const wrapper = document.createElement("div");

  if (msg.type === "poll") {
    wrapper.className = "poll-card";
    wrapper.setAttribute("data-poll-id", msg.id);

    const totalVotes = msg.options.reduce((sum, opt) => sum + opt.votes.length, 0);

    const optionsHTML = msg.options.map(opt => {
      const percent = totalVotes > 0 ? Math.round((opt.votes.length / totalVotes) * 100) : 0;
      const isVotedByMe = opt.votes.includes(username);

      return `
        <div class="poll-option-row ${isVotedByMe ? 'voted' : ''}" data-option-id="${opt.id}" onclick="castVote('${msg.id}', ${opt.id})">
          <div class="poll-progress-bar" style="width: ${percent}%"></div>
          <div class="poll-option-content">
            <span class="option-text">${escapeHTML(opt.text)}</span>
            <span class="vote-count">${opt.votes.length} (${percent}%)</span>
          </div>
        </div>
      `;
    }).join('');

    wrapper.innerHTML = `
      <div class="message-meta"><strong>${escapeHTML(msg.sender)}</strong> created a poll • ${msg.timestamp}</div>
      <div class="poll-question">${escapeHTML(msg.question)}</div>
      <div class="poll-options">${optionsHTML}</div>
    `;
  } else {
    wrapper.className = "message-card";
    wrapper.innerHTML = `
      <div class="message-meta"><strong>${escapeHTML(msg.sender)}</strong> • ${msg.timestamp}</div>
      <div class="message-body">${escapeHTML(msg.text)}</div>
    `;
  }

  chatMessages.appendChild(wrapper);
}

// Global click function for poll options
window.castVote = function(pollId, optionId) {
  socket.emit("cast_vote", { pollId, optionId });
};

// Modal Control Listeners
openPollModalBtn.addEventListener("click", () => pollModal.classList.remove("hidden"));
closeModalBtn.addEventListener("click", () => pollModal.classList.add("hidden"));

addOptionBtn.addEventListener("click", () => {
  const count = pollOptionsContainer.querySelectorAll(".poll-opt-input").length + 1;
  if (count > 6) return alert("Maximum 6 options allowed.");
  
  const input = document.createElement("input");
  input.type = "text";
  input.className = "poll-opt-input";
  input.placeholder = `Option ${count}`;
  input.required = true;
  pollOptionsContainer.appendChild(input);
});

pollForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = document.getElementById("poll-question").value.trim();
  const optionInputs = document.querySelectorAll(".poll-opt-input");
  const options = Array.from(optionInputs).map(i => i.value.trim()).filter(Boolean);

  if (question && options.length >= 2) {
    socket.emit("create_poll", { question, options });
    
    pollForm.reset();
    pollOptionsContainer.innerHTML = `
      <input type="text" class="poll-opt-input" placeholder="Option 1" required>
      <input type="text" class="poll-opt-input" placeholder="Option 2" required>
    `;
    pollModal.classList.add("hidden");
  }
});

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}
