// ==========================================
// CHAT
// Текстовый чат комнаты
// ==========================================
// ТЕКСТОВЫЙ ЧАТ
// ==========================================
const chatPanel = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const chatEmpty = document.getElementById('chatEmpty');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatToggleBtn = document.getElementById('chatToggleBtn');
const chatUnread = document.getElementById('chatUnread');
let unreadCount = 0;
let currentChatHistory = [];

function isChatOpen() {
  return chatPanel.style.display !== 'none';
}

function setChatOpen(open) {
  chatPanel.style.display = open ? 'flex' : 'none';
  chatToggleBtn.classList.toggle('active', open);
  localStorage.setItem('dubline_chat_open', open ? '1' : '0');
  if (open) {
    unreadCount = 0;
    chatUnread.style.display = 'none';
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

window.toggleChat = function() {
  setChatOpen(!isChatOpen());
};

function appendChatMessage(msg) {
  chatEmpty.style.display = 'none';
  const atBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 40;

  const el = document.createElement('div');
  if (msg.system) {
    el.className = 'chat-msg system';
    el.textContent = msg.key ? t(msg.key, msg.params || {}) : msg.text;
  } else {
    const time = new Date(msg.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    el.className = 'chat-msg' + (msg.nick === myName ? ' me' : '');
    el.innerHTML = `<span class="chat-time">${time}</span> <strong class="chat-nick">${esc(msg.nick)}:</strong> <span>${esc(msg.text)}</span>`;
  }
  chatMessages.appendChild(el);

  if (atBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderChatHistory() {
  chatMessages.querySelectorAll('.chat-msg').forEach(el => el.remove());
  chatEmpty.style.display = currentChatHistory.length ? 'none' : 'block';
  currentChatHistory.forEach(appendChatMessage);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

socket.on('chat_history', (history) => {
  currentChatHistory = history;
  renderChatHistory();
});

socket.on('chat_message', (msg) => {
  currentChatHistory.push(msg);
  if (currentChatHistory.length > 100) currentChatHistory.shift();
  appendChatMessage(msg);
  if (!isChatOpen() && msg.nick !== myName) {
    unreadCount++;
    chatUnread.innerText = unreadCount > 99 ? '99+' : unreadCount;
    chatUnread.style.display = 'inline-block';
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  if (!myName) {
    showNickModal();
    return;
  }
  socket.emit('chat_message', { text });
  chatInput.value = '';
});

setChatOpen(localStorage.getItem('dubline_chat_open') !== '0');
