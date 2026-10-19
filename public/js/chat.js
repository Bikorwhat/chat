// ============================================================
// chat.js — fchat Chat Room Logic
// Socket.io + MediaRecorder + Drag & Drop + Voice Notes
// ============================================================

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;   // 10MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;   // 50MB
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;   // 10MB
const MAX_VOICE_SECONDS = 120;               // 2 minutes
const EMOJI_REACTIONS = ['👍','❤️','😂','👀','😮','🍑','😢','🔥','👏','🎉','💦','😭','😉','🥵',];

// ─── DOM Refs ──────────────────────────────────────────────────────────────
const dom = {
  app: document.getElementById('js-app'),
  loading: document.getElementById('js-loading'),
  loadingStatus: document.getElementById('js-loading-status'),

  // Sidebar
  sidebar: document.getElementById('js-sidebar'),
  sidebarOpen: document.getElementById('js-sidebar-open'),
  sidebarClose: document.getElementById('js-sidebar-close'),
  spaceIdDisplay: document.getElementById('js-space-id-display'),
  copyLink: document.getElementById('js-copy-link'),
  userList: document.getElementById('js-user-list'),
  userCount: document.getElementById('js-user-count'),
  myAvatar: document.getElementById('js-my-avatar'),
  myName: document.getElementById('js-my-name'),

  // Header
  headerSpaceId: document.getElementById('js-header-space-id'),
  headerUserCount: document.getElementById('js-header-user-count'),
  chatModeLabel: document.getElementById('js-chat-mode-label'),
  headerCopyLink: document.getElementById('js-header-copy-link'),
  leaveBtn: document.getElementById('js-leave-btn'),

  // Messages
  messages: document.getElementById('js-messages'),
  emptyState: document.getElementById('js-empty-state'),
  typingBar: document.getElementById('js-typing-bar'),

  // Drop zone
  dropZone: document.getElementById('js-drop-zone'),

  // Recorder
  recorderBar: document.getElementById('js-recorder-bar'),
  recTimer: document.getElementById('js-rec-timer'),
  recStop: document.getElementById('js-rec-stop'),
  recCancel: document.getElementById('js-rec-cancel'),

  // Input
  attachBtn: document.getElementById('js-attach-btn'),
  fileInput: document.getElementById('js-file-input'),
  mediaOptionsModal: document.getElementById('js-media-options-modal'),
  mediaFileSummary: document.getElementById('js-media-file-summary'),
  mediaViewDuration: document.getElementById('js-media-view-duration'),
  mediaCancel: document.getElementById('js-media-cancel'),
  mediaSend: document.getElementById('js-media-send'),
  micBtn: document.getElementById('js-mic-btn'),
  messageInput: document.getElementById('js-message-input'),
  sendBtn: document.getElementById('js-send-btn'),
  replyPreview: document.getElementById('js-reply-preview'),
  replyName: document.getElementById('js-reply-name'),
  replyText: document.getElementById('js-reply-text'),
  replyCancel: document.getElementById('js-reply-cancel'),

  // Name modal
  nameModal: document.getElementById('js-name-modal'),
  nameInput: document.getElementById('js-name-input'),
  nameHint: document.getElementById('js-name-hint'),
  nameConfirm: document.getElementById('js-name-confirm'),
  nameCancel: document.getElementById('js-name-cancel'),

  // Lightbox
  lightbox: document.getElementById('js-lightbox'),
  lightboxMedia: document.getElementById('js-lightbox-media'),
  lightboxClose: document.getElementById('js-lightbox-close'),
  lightboxBackdrop: document.getElementById('js-lightbox-backdrop'),

  // Toast
  toast: document.getElementById('js-toast'),
};

// ─── State ─────────────────────────────────────────────────────────────────
const state = {
  roomId: null,
  myId: null,
  myName: null,
  users: new Map(),
  messages: new Map(),    // msgId → DOM element
  replyTo: null,          // { id, text, senderName }
  typingUsers: new Map(), // userId → name
  typingTimeout: null,
  isTyping: false,
  msgCount: 0,
  protectedMedia: new Map(),
  activeMediaViewer: null,
  pendingMediaEntry: null,
};

let pendingMediaFile = null;
let pendingMediaDuration = null;

// ─── Voice Recorder State ──────────────────────────────────────────────────
const recorder = {
  mediaRecorder: null,
  chunks: [],
  startTime: null,
  timerInterval: null,
  stream: null,
};

// ─── Blob URLs (tracked for cleanup) ──────────────────────────────────────
const blobUrls = new Set();

// ─── XSS Sanitizer ────────────────────────────────────────────────────────
function sanitize(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str)));
  return div.innerHTML;
}

// ─── Linkify (convert URLs in text to clickable links safely) ─────────────
function linkifyText(text) {
  const safe = sanitize(text);
  return safe.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#8b5cf6;text-decoration:underline;">$1</a>'
  );
}

// ─── Format Timestamp ─────────────────────────────────────────────────────
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Toast ─────────────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  dom.toast.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── Avatar helpers ────────────────────────────────────────────────────────
function getInitials(name) {
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function makeAvatar(name, color, size = 28) {
  const el = document.createElement('div');
  el.className = 'avatar msg-avatar';
  el.style.cssText = `background:${color};width:${size}px;height:${size}px;font-size:${size * 0.35}px;`;
  el.textContent = getInitials(name);
  el.title = name;
  return el;
}

// ─── Navigate to Room ──────────────────────────────────────────────────────
function getRoomIdFromPath() {
  const match = window.location.pathname.match(/^\/space\/([\w-]+)$/);
  return match ? match[1] : null;
}

function getDisplayName() {
  return sessionStorage.getItem('chyatt_name') || sessionStorage.getItem('fchat_name') || '';
}

// ─── Socket Setup ──────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });
let pageIsLeaving = false;

socket.on('connect', () => {
  const roomId = getRoomIdFromPath();
  if (!roomId) {
    window.location.href = '/';
    return;
  }
  state.roomId = roomId;
  const name = getDisplayName();
  if (!name) {
    showNameModal();
    return;
  }
  joinRoom(name);
});

socket.on('disconnect', () => {
  if (pageIsLeaving) return;
  showToast('Connection lost. Reconnecting...', 'error');
});

socket.on('connect_error', () => {
  dom.loadingStatus.textContent = 'Connection failed. Retrying...';
});

socket.on('error', ({ message }) => {
  showToast(message, 'error');
  if (message === 'Space not found.') {
    dom.loadingStatus.textContent = 'Space does not exist. Returning home...';
    showToast('Space does not exist. Returning home...', 'error', 1500);
    setTimeout(() => window.location.replace('/'), 1200);
  }
});

// ─── Room events ───────────────────────────────────────────────────────────
socket.on('room-history', ({ history, users, myId }) => {
  state.myId = myId;
  updateUserList(users);

  // Render history
  history.forEach((msg) => {
    renderMessage(msg);
    msg.reactions?.forEach(({ emoji, users }) => {
      users.forEach(({ id }) => addReactionToMessage(msg.id, emoji, id));
    });
  });

  // Show UI
  dom.loading.style.display = 'none';
  dom.app.removeAttribute('hidden');
  dom.headerSpaceId.textContent = state.roomId;
  dom.spaceIdDisplay.textContent = state.roomId;
  document.title = `chyatt — ${state.roomId}`;

  // Set my identity in sidebar
  const me = users.find(u => u.id === myId);
  if (me) {
    state.myName = me.name;
    dom.myName.textContent = me.name;
    dom.myAvatar.textContent = getInitials(me.name);
    dom.myAvatar.style.background = me.color;
  }

  scrollToBottom(false);
});

socket.on('user-list', ({ users }) => {
  updateUserList(users);
});

socket.on('message', (msg) => {
  renderMessage(msg);
  scrollToBottom(true);
});

socket.on('media-content', (payload) => revealProtectedMedia(payload));
socket.on('media-expired', ({ msgId }) => expireProtectedMedia(msgId));
socket.on('message-expired', ({ msgId }) => removeExpiredMessage(msgId));
socket.on('media-unavailable', ({ msgId, requestId, reason }) => {
  const entry = state.protectedMedia.get(msgId);
  if (!entry || entry.requestId !== requestId) return;
  entry.requestPending = false;
  if (state.pendingMediaEntry === entry) state.pendingMediaEntry = null;
  if (reason === 'not-eligible') {
    entry.canViewMedia = false;
  } else if (reason === 'views-used') {
    entry.remainingViews = 0;
  }
  updateMediaTag(entry);
});

socket.on('user-typing', ({ userId, name }) => {
  state.typingUsers.set(userId, name);
  renderTypingIndicator();
});

socket.on('user-stop-typing', ({ userId }) => {
  state.typingUsers.delete(userId);
  renderTypingIndicator();
});

socket.on('reaction', ({ msgId, emoji, userId, previousEmoji }) => {
  addReactionToMessage(msgId, emoji, userId, previousEmoji);
});

// ─── Join Room ─────────────────────────────────────────────────────────────
function joinRoom(displayName) {
  state.myName = displayName;
  dom.loadingStatus.textContent = `Joining ${state.roomId}...`;
  socket.emit('join-room', { roomId: state.roomId, displayName });
}

// ─── Update User List ──────────────────────────────────────────────────────
function updateUserList(users) {
  state.users.clear();
  users.forEach(u => state.users.set(u.id, u));

  dom.userList.innerHTML = '';
  users.forEach(u => {
    const li = document.createElement('li');
    li.className = `user-item${u.id === state.myId ? ' user-item--me' : ''}`;
    li.dataset.userId = u.id;

    const avatar = makeAvatar(u.name, u.color, 30);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'user-item-name';
    nameSpan.textContent = u.name;
    const online = document.createElement('span');
    online.className = 'user-item-online';
    online.title = 'Online';

    li.append(avatar, nameSpan, online);
    dom.userList.appendChild(li);
  });

  const count = users.length;
  dom.userCount.textContent = count;
  dom.headerUserCount.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
  dom.chatModeLabel.textContent = count <= 1 ? 'Waiting...' : count === 2 ? '1-on-1 Chat' : 'Group Chat';
}

// ─── Render Message ────────────────────────────────────────────────────────
function renderMessage(msg) {
  if (state.messages.has(msg.id)) return; // dedupe

  dom.emptyState.classList.add('hidden');
  state.msgCount++;

  if (msg.type === 'system') {
    renderSystemMessage(msg);
    return;
  }

  const isOwn = msg.sender?.id === state.myId;
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-group';
  wrapper.dataset.msgId = msg.id;
  wrapper.id = msg.id;

  const msgWrapper = document.createElement('div');
  msgWrapper.className = `msg-wrapper${isOwn ? ' msg-wrapper--own' : ''}`;

  // Avatar (only for others)
  if (!isOwn && msg.sender) {
    const sender = msg.sender;
    const av = makeAvatar(sender.name, sender.color);
    msgWrapper.appendChild(av);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  // Sender name (only for others in group)
  if (!isOwn && msg.sender && state.users.size > 2) {
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-sender-name';
    nameEl.style.color = msg.sender.color;
    nameEl.textContent = sanitize(msg.sender.name);
    body.appendChild(nameEl);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  // Reply reference
  if (msg.replyTo && state.messages.has(msg.replyTo)) {
    const refEl = state.messages.get(msg.replyTo);
    const refBubble = refEl?.querySelector('.msg-bubble-text') || refEl?.querySelector('.msg-bubble');
    if (refBubble) {
      const refDiv = document.createElement('div');
      refDiv.className = 'msg-reply-ref';
      const refSenderName = refEl?.querySelector('.msg-sender-name')?.textContent || 'Someone';
      refDiv.innerHTML = `<strong>${sanitize(refSenderName)}</strong><br>${sanitize(refBubble.textContent.slice(0, 80))}`;
      bubble.appendChild(refDiv);
    }
  }

  // Content
  if (msg.type === 'text') {
    const textEl = document.createElement('div');
    textEl.className = 'msg-bubble-text';
    textEl.innerHTML = linkifyText(msg.text);
    bubble.appendChild(textEl);
  } else if (msg.type === 'media') {
    renderMediaContent(bubble, msg);
  }

  // Click to react
  bubble.addEventListener('click', (e) => {
    if (e.target.closest('a') || e.target.closest('button') || e.target.closest('audio') || e.target.closest('video')) return;
    showEmojiPicker(msg.id, e);
  });

  const timeEl = document.createElement('div');
  timeEl.className = 'msg-time';
  timeEl.textContent = formatTime(msg.timestamp);

  const reactionButton = document.createElement('button');
  reactionButton.className = 'msg-reaction-action';
  reactionButton.type = 'button';
  reactionButton.title = 'Add reaction';
  reactionButton.setAttribute('aria-label', 'Add reaction');
  reactionButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/></svg>';
  reactionButton.addEventListener('click', (event) => {
    event.stopPropagation();
    showEmojiPicker(msg.id, event);
  });

  const replyButton = document.createElement('button');
  replyButton.className = 'msg-reply-action';
  replyButton.type = 'button';
  replyButton.title = 'Reply';
  replyButton.setAttribute('aria-label', 'Reply to message');
  replyButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 15-5-5 5-5"/><path d="M4 10h9a5 5 0 0 1 5 5v1"/></svg>';
  replyButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setReply(msg);
  });

  const contentRow = document.createElement('div');
  contentRow.className = 'msg-content-row';
  const contentActions = document.createElement('div');
  contentActions.className = 'msg-content-actions';
  contentActions.append(reactionButton, replyButton);
  contentRow.append(bubble, contentActions);

  const messageMeta = document.createElement('div');
  messageMeta.className = 'msg-meta';
  messageMeta.append(timeEl);

  const reactionsEl = document.createElement('div');
  reactionsEl.className = 'msg-reactions';
  reactionsEl.dataset.msgId = msg.id;

  body.append(contentRow, messageMeta, reactionsEl);
  msgWrapper.appendChild(body);
  wrapper.appendChild(msgWrapper);
  dom.messages.appendChild(wrapper);

  state.messages.set(msg.id, wrapper);
  if (window.location.hash === `#${msg.id}`) {
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderSystemMessage(msg) {
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.dataset.msgId = msg.id;
  const span = document.createElement('span');
  span.className = 'msg-system-text';
  span.textContent = msg.text; // server already sanitized
  div.appendChild(span);
  dom.messages.appendChild(div);
  state.messages.set(msg.id, div);
}

// ─── Media Content ─────────────────────────────────────────────────────────
function renderMediaContent(bubble, msg) {
  bubble.style.padding = '6px';
  bubble.style.background = 'transparent';
  bubble.style.border = 'none';

  if (msg.expired || msg.data === '[media-ref]') {
    const placeholder = document.createElement('div');
    placeholder.textContent = msg.expired ? 'Media expired' : '[Media no longer available]';
    placeholder.style.cssText = 'font-size:0.78rem;color:var(--text-muted);padding:8px 12px;';
    bubble.appendChild(placeholder);
    return;
  }

  renderProtectedMedia(bubble, msg);
}

function renderProtectedMedia(bubble, msg) {
  const wrapper = document.createElement('div');
  const isSender = msg.sender?.id === state.myId;
  const restricted = Number.isInteger(msg.viewLimit);
  wrapper.className = `msg-media protected-media${restricted ? ' protected-media--restricted' : ''}`;

  const trigger = document.createElement('button');
  trigger.className = 'protected-media-trigger';
  trigger.type = 'button';
  const preview = document.createElement('span');
  preview.className = 'protected-media-preview';
  if (msg.previewData) {
    const image = document.createElement('img');
    image.src = `data:image/jpeg;base64,${msg.previewData}`;
    image.alt = '';
    image.draggable = false;
    preview.appendChild(image);
  } else {
    preview.textContent = msg.mediaType === 'video' ? '▶' : msg.mediaType === 'audio' ? '♫' : '▧';
  }

  const label = document.createElement('span');
  label.className = 'protected-media-label';
  label.textContent = getMediaTypeLabel(msg.mediaType);
  trigger.append(preview, label);

  const status = document.createElement('div');
  status.className = 'protected-media-status';
  const canViewMedia = msg.canViewMedia !== false;
  const remainingViews = msg.remainingViews ?? msg.viewLimit;
  wrapper.append(trigger, status);
  bubble.appendChild(wrapper);

  const entry = {
    wrapper,
    trigger,
    preview,
    label,
    status,
    message: msg,
    isSender,
    restricted,
    canViewMedia,
    remainingViews,
    requestPending: false,
    requestId: null,
    activeView: false,
    expired: false,
    objectUrl: null,
  };
  trigger.addEventListener('click', () => requestProtectedMedia(entry));
  trigger.addEventListener('contextmenu', preventMediaInteraction);
  trigger.addEventListener('dblclick', preventMediaInteraction);
  updateMediaTag(entry);
  state.protectedMedia.set(msg.id, entry);
}

function getMediaTypeLabel(mediaType) {
  if (mediaType === 'video') return 'Video';
  if (mediaType === 'audio') return 'Voice message';
  return 'Photo';
}

function updateMediaTag(entry) {
  const typeLabel = getMediaTypeLabel(entry.message.mediaType);
  entry.trigger.disabled = entry.expired || (!entry.isSender && (
    !entry.canViewMedia || (entry.restricted && entry.remainingViews === 0)
  ));

  if (entry.expired) {
    entry.label.textContent = `${typeLabel} · Expired`;
    entry.status.hidden = true;
  } else if (!entry.canViewMedia) {
    entry.label.textContent = typeLabel;
    entry.status.textContent = 'You were not in the room when this was sent';
    entry.status.hidden = false;
  } else if (entry.restricted && !entry.isSender) {
    entry.label.textContent = typeLabel;
    entry.status.textContent = entry.remainingViews === 0
      ? 'You have used your views'
      : `${entry.remainingViews} ${entry.remainingViews === 1 ? 'view' : 'views'} remaining`;
    entry.status.hidden = false;
  } else if (entry.restricted && entry.isSender) {
    entry.label.textContent = typeLabel;
    entry.status.textContent = `Each recipient gets ${entry.message.viewLimit} ${entry.message.viewLimit === 1 ? 'view' : 'views'}`;
    entry.status.hidden = false;
  } else {
    entry.label.textContent = typeLabel;
    entry.status.hidden = true;
  }
}

function requestProtectedMedia(entry) {
  if (entry.requestPending || entry.expired || state.activeMediaViewer || state.pendingMediaEntry) return;
  if (!entry.isSender && (!entry.canViewMedia || (entry.restricted && entry.remainingViews === 0))) return;
  entry.requestPending = true;
  entry.requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.pendingMediaEntry = entry;
  entry.status.textContent = 'Loading media...';
  entry.status.hidden = false;
  socket.emit('request-media', { msgId: entry.message.id, requestId: entry.requestId });
}

function revealProtectedMedia({ msgId, requestId, data, mimeType, senderPreview, remainingViews }) {
  const entry = state.protectedMedia.get(msgId);
  if (!entry || entry.requestId !== requestId) return;

  entry.requestPending = false;
  state.pendingMediaEntry = null;
  if (entry.restricted && !senderPreview) {
    entry.remainingViews = remainingViews;
    entry.activeView = true;
  }
  updateMediaTag(entry);
  entry.objectUrl = createBlobUrl(data, mimeType);
  openLightbox(entry.message.mediaType, entry.objectUrl, entry);
}

function preventMediaInteraction(event) {
  event.preventDefault();
}

function expireProtectedMedia(msgId) {
  const entry = state.protectedMedia.get(msgId);
  if (!entry) return;
  entry.expired = true;
  entry.message.expired = true;
  if (state.activeMediaViewer?.entry === entry) closeLightbox({ finishView: false });
  updateMediaTag(entry);
}

function removeExpiredMessage(msgId) {
  const messageElement = state.messages.get(msgId);
  if (!messageElement) return;

  const mediaEntry = state.protectedMedia.get(msgId);
  if (mediaEntry) {
    if (state.activeMediaViewer?.entry === mediaEntry) {
      closeLightbox({ finishView: false });
    } else if (mediaEntry.objectUrl) {
      URL.revokeObjectURL(mediaEntry.objectUrl);
      blobUrls.delete(mediaEntry.objectUrl);
    }
    if (state.pendingMediaEntry === mediaEntry) state.pendingMediaEntry = null;
    state.protectedMedia.delete(msgId);
  }

  if (state.replyTo?.id === msgId) clearReply();
  messageElement.remove();
  state.messages.delete(msgId);
}

function base64ToBlob(base64, mimeType) {
  const byteString = atob(base64);
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
  return new Blob([ab], { type: mimeType });
}

function createBlobUrl(base64, mimeType) {
  const blob = base64ToBlob(base64, mimeType);
  const url = URL.createObjectURL(blob);
  blobUrls.add(url);
  return url;
}

// ─── Lightbox ──────────────────────────────────────────────────────────────
function openLightbox(type, url, entry) {
  dom.lightboxMedia.innerHTML = '';
  let el;
  if (type === 'image') {
    el = document.createElement('img');
    el.src = url;
    el.alt = 'Full size image';
  } else if (type === 'video') {
    el = document.createElement('video');
    el.src = url;
    el.controls = true;
    el.setAttribute('controlsList', 'nodownload noremoteplayback');
    el.disablePictureInPicture = true;
    el.addEventListener('ended', () => closeLightbox(), { once: true });
  } else {
    el = document.createElement('audio');
    el.src = url;
    el.controls = true;
    el.addEventListener('ended', () => closeLightbox(), { once: true });
  }
  el.addEventListener('contextmenu', preventMediaInteraction);
  el.addEventListener('dblclick', preventMediaInteraction);
  el.addEventListener('dragstart', preventMediaInteraction);
  el.draggable = false;
  dom.lightboxMedia.appendChild(el);
  dom.lightbox.removeAttribute('hidden');
  document.body.style.overflow = 'hidden';
  const timeoutId = type === 'image' ? setTimeout(() => closeLightbox(), 5000) : null;
  state.activeMediaViewer = { entry, element: el, url, timeoutId };
  if (type !== 'image') el.play().catch(() => {});
}

function closeLightbox({ finishView = true } = {}) {
  const viewer = state.activeMediaViewer;
  if (!viewer) return;
  clearTimeout(viewer.timeoutId);
  viewer.element.pause?.();
  viewer.element.removeAttribute('src');
  viewer.element.load?.();
  if (viewer.entry.activeView) {
    if (finishView) socket.emit('finish-media-view', { msgId: viewer.entry.message.id });
    viewer.entry.activeView = false;
    updateMediaTag(viewer.entry);
  }
  URL.revokeObjectURL(viewer.url);
  blobUrls.delete(viewer.url);
  viewer.entry.objectUrl = null;
  state.activeMediaViewer = null;
  dom.lightboxMedia.innerHTML = '';
  dom.lightbox.setAttribute('hidden', '');
  document.body.style.overflow = '';
}

dom.lightboxClose.addEventListener('click', closeLightbox);
dom.lightboxBackdrop.addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

// ─── Typing Indicator ──────────────────────────────────────────────────────
function renderTypingIndicator() {
  const typers = Array.from(state.typingUsers.values()).filter(n => n !== state.myName);
  if (typers.length === 0) {
    dom.typingBar.innerHTML = '';
    return;
  }
  const names = typers.length === 1
    ? typers[0]
    : typers.length === 2
    ? `${typers[0]} and ${typers[1]}`
    : `${typers.length} people`;

  dom.typingBar.innerHTML = `
    <div class="typing-dots"><span></span><span></span><span></span></div>
    <span>${sanitize(names)} ${typers.length === 1 ? 'is' : 'are'} typing...</span>
  `;
}

// ─── Reactions / Emoji picker ──────────────────────────────────────────────
let activeEmojiPicker = null;

function showEmojiPicker(msgId, e) {
  closeEmojiPicker();

  const picker = document.createElement('div');
  picker.className = 'emoji-picker-popup';
  picker.style.left = `${Math.min(e.clientX, window.innerWidth - 220)}px`;
  picker.style.top = `${e.clientY - 60}px`;

  EMOJI_REACTIONS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      socket.emit('react', { msgId, emoji });
      closeEmojiPicker();
    });
    picker.appendChild(btn);
  });

  document.body.appendChild(picker);
  activeEmojiPicker = picker;

  setTimeout(() => {
    document.addEventListener('click', closeEmojiPicker, { once: true });
  }, 10);
}

function closeEmojiPicker() {
  if (activeEmojiPicker) {
    activeEmojiPicker.remove();
    activeEmojiPicker = null;
  }
}

function addReactionToMessage(msgId, emoji, userId, previousEmoji = null) {
  const msgEl = state.messages.get(msgId);
  if (!msgEl) return;
  const reactionsEl = msgEl.querySelector(`.msg-reactions[data-msg-id="${msgId}"]`);
  if (!reactionsEl) return;

  if (previousEmoji) {
    const previousChip = reactionsEl.querySelector(`[data-emoji="${CSS.escape(previousEmoji)}"]`);
    if (previousChip) {
      const previousUsers = JSON.parse(previousChip.dataset.users).filter((id) => id !== userId);
      if (previousUsers.length === 0) {
        previousChip.remove();
      } else {
        previousChip.dataset.users = JSON.stringify(previousUsers);
        previousChip.querySelector('.reaction-count').textContent = previousUsers.length;
        if (userId === state.myId) previousChip.classList.remove('reaction-chip--mine');
      }
    }
  }

  // Find or create chip for this emoji
  let chip = reactionsEl.querySelector(`[data-emoji="${CSS.escape(emoji)}"]`);
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'reaction-chip';
    chip.dataset.emoji = emoji;
    chip.dataset.users = JSON.stringify([]);
    chip.innerHTML = `<span>${emoji}</span> <span class="reaction-count">0</span>`;
    reactionsEl.appendChild(chip);
  }

  const users = JSON.parse(chip.dataset.users);
  if (!users.includes(userId)) {
    users.push(userId);
    chip.dataset.users = JSON.stringify(users);
    const countEl = chip.querySelector('.reaction-count');
    if (countEl) countEl.textContent = users.length;
    if (userId === state.myId) chip.classList.add('reaction-chip--mine');
  }
}

// ─── Reply ─────────────────────────────────────────────────────────────────
function setReply(msg) {
  const previewText = msg.type === 'text' ? msg.text : `[${msg.mediaType}]`;
  state.replyTo = { id: msg.id, text: previewText, senderName: msg.sender?.name || 'Unknown' };
  dom.replyName.textContent = sanitize(state.replyTo.senderName);
  dom.replyText.textContent = sanitize(previewText.slice(0, 60));
  dom.replyPreview.removeAttribute('hidden');
  dom.messageInput.focus();
}

function clearReply() {
  state.replyTo = null;
  dom.replyPreview.setAttribute('hidden', '');
}

dom.replyCancel.addEventListener('click', clearReply);

// ─── Send Text Message ─────────────────────────────────────────────────────
function sendTextMessage() {
  const text = dom.messageInput.value.trim();
  if (!text) return;

  socket.emit('send-message', {
    text,
    replyTo: state.replyTo?.id || null,
  });

  dom.messageInput.value = '';
  dom.messageInput.style.height = 'auto';
  clearReply();
  updateSendBtn();
  stopTyping();
}

dom.sendBtn.addEventListener('click', sendTextMessage);

dom.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
});

// ─── Typing detection ──────────────────────────────────────────────────────
dom.messageInput.addEventListener('input', () => {
  updateSendBtn();
  autoResizeTextarea();

  if (!state.isTyping) {
    state.isTyping = true;
    socket.emit('typing-start');
  }
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(stopTyping, 2000);
});

function stopTyping() {
  if (state.isTyping) {
    state.isTyping = false;
    socket.emit('typing-stop');
  }
  clearTimeout(state.typingTimeout);
}

function updateSendBtn() {
  dom.sendBtn.disabled = !dom.messageInput.value.trim();
}

function autoResizeTextarea() {
  dom.messageInput.style.height = 'auto';
  dom.messageInput.style.height = Math.min(dom.messageInput.scrollHeight, 160) + 'px';
}

// ─── Scroll to Bottom ──────────────────────────────────────────────────────
function scrollToBottom(smooth = true) {
  requestAnimationFrame(() => {
    dom.messages.scrollTo({
      top: dom.messages.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    });
  });
}

// ─── File Upload ───────────────────────────────────────────────────────────
dom.attachBtn.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
  dom.fileInput.value = '';
});
dom.mediaCancel.addEventListener('click', closeMediaOptions);
dom.mediaSend.addEventListener('click', sendPendingMedia);

function closeMediaOptions() {
  pendingMediaFile = null;
  pendingMediaDuration = null;
  dom.mediaOptionsModal.setAttribute('hidden', '');
}

function openMediaOptions(file, duration = null) {
  pendingMediaFile = file;
  pendingMediaDuration = duration;
  const type = file.type.startsWith('image/') ? 'Photo' : file.type.startsWith('video/') ? 'Video' : 'Audio';
  dom.mediaFileSummary.textContent = `${type} · ${formatBytes(file.size)}. Hidden until opened.`;
  dom.mediaOptionsModal.removeAttribute('hidden');
}

function handleFile(file) {
  const { type, size, name } = file;
  const isImage = type.startsWith('image/');
  const isVideo = type.startsWith('video/');
  const isAudio = type.startsWith('audio/');

  if (!isImage && !isVideo && !isAudio) {
    showToast('Unsupported file type. Use images, videos, or audio.', 'error');
    return;
  }

  // Size validation
  if (isImage && size > MAX_IMAGE_BYTES) {
    showToast(`Images must be under 10MB. Your file is ${formatBytes(size)}.`, 'error');
    return;
  }
  if (isVideo && size > MAX_VIDEO_BYTES) {
    showToast(`Videos must be under 50MB. Your file is ${formatBytes(size)}.`, 'error');
    return;
  }
  if (isAudio && size > MAX_AUDIO_BYTES) {
    showToast(`Audio must be under 10MB. Your file is ${formatBytes(size)}.`, 'error');
    return;
  }

  openMediaOptions(file);
}

async function makeBlurPreview(file) {
  if (!file.type.startsWith('image/')) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 72 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.25).split(',')[1];
  } catch (error) {
    return null;
  }
}

async function sendPendingMedia() {
  const file = pendingMediaFile;
  if (!file) return;

  const viewLimit = Number(dom.mediaViewDuration.value);
  const mediaType = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'audio';
  const duration = pendingMediaDuration;
  closeMediaOptions();

  const progressId = `upload-${Date.now()}`;
  const progressEl = renderUploadProgress(`Sending ${mediaType}`, progressId);
  const previewData = await makeBlurPreview(file);
  const reader = new FileReader();
  reader.onprogress = (event) => {
    if (event.lengthComputable) updateUploadProgress(progressId, Math.round((event.loaded / event.total) * 100));
  };
  reader.onload = () => {
    updateUploadProgress(progressId, 100);
    socket.emit('send-media', {
      mediaType,
      mimeType: file.type || 'application/octet-stream',
      data: reader.result.split(',')[1],
      previewData,
      viewLimit,
      duration,
    });
    setTimeout(() => progressEl?.remove(), 800);
  };
  reader.onerror = () => {
    showToast('Failed to read media.', 'error');
    progressEl?.remove();
  };
  reader.readAsDataURL(file);
}

function renderUploadProgress(name, id) {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-group';
  wrapper.id = id;

  const div = document.createElement('div');
  div.className = 'upload-progress-msg';
  div.innerHTML = `
    <span>📎 ${sanitize(name)}</span>
    <div class="progress-bar-wrap">
      <div class="progress-bar-fill" style="width:0%"></div>
    </div>
    <span class="pct">0%</span>
  `;

  wrapper.appendChild(div);
  dom.messages.appendChild(wrapper);
  dom.emptyState.classList.add('hidden');
  scrollToBottom(true);
  return wrapper;
}

function updateUploadProgress(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const fill = el.querySelector('.progress-bar-fill');
  const pctEl = el.querySelector('.pct');
  if (fill) fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
}

// ─── Drag & Drop ───────────────────────────────────────────────────────────
const chatMain = document.querySelector('.chat-main');

chatMain.addEventListener('dragover', (e) => {
  e.preventDefault();
  dom.dropZone.classList.add('active');
});
chatMain.addEventListener('dragleave', (e) => {
  if (!chatMain.contains(e.relatedTarget)) {
    dom.dropZone.classList.remove('active');
  }
});
chatMain.addEventListener('drop', (e) => {
  e.preventDefault();
  dom.dropZone.classList.remove('active');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// ─── Voice Recorder ────────────────────────────────────────────────────────
dom.micBtn.addEventListener('click', () => {
  if (recorder.mediaRecorder && recorder.mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    startRecording();
  }
});

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('Microphone not supported in this browser.', 'error');
    return;
  }

  try {
    recorder.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('Microphone access denied.', 'error');
    return;
  }

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
    ? 'audio/ogg;codecs=opus'
    : 'audio/webm';

  recorder.chunks = [];
  recorder.startTime = Date.now();
  recorder.mediaRecorder = new MediaRecorder(recorder.stream, { mimeType });

  recorder.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recorder.chunks.push(e.data);
  };

  recorder.mediaRecorder.onstop = async () => {
    const blob = new Blob(recorder.chunks, { type: mimeType });
    const duration = (Date.now() - recorder.startTime) / 1000;
    await sendVoiceNote(blob, mimeType, duration);
    cleanupRecorder();
  };

  recorder.mediaRecorder.start(250); // Collect in 250ms chunks

  // Show recorder UI
  dom.recorderBar.removeAttribute('hidden');
  dom.micBtn.classList.add('recording');
  dom.micBtn.title = 'Stop recording';

  // Timer
  recorder.timerInterval = setInterval(() => {
    const elapsed = (Date.now() - recorder.startTime) / 1000;
    dom.recTimer.textContent = formatDuration(elapsed);

    // Auto-stop at 2 minutes
    if (elapsed >= MAX_VOICE_SECONDS) {
      showToast('Voice note limit reached (2 min). Sending...', 'info');
      stopRecording();
    }
  }, 500);
}

function stopRecording() {
  if (recorder.mediaRecorder && recorder.mediaRecorder.state === 'recording') {
    recorder.mediaRecorder.stop();
  }
  dom.recorderBar.setAttribute('hidden', '');
  dom.micBtn.classList.remove('recording');
  dom.micBtn.title = 'Record voice note';
  if (recorder.timerInterval) {
    clearInterval(recorder.timerInterval);
    recorder.timerInterval = null;
  }
}

function cancelRecording() {
  recorder.chunks = [];
  if (recorder.mediaRecorder && recorder.mediaRecorder.state === 'recording') {
    recorder.mediaRecorder.ondataavailable = null;
    recorder.mediaRecorder.onstop = null;
    recorder.mediaRecorder.stop();
  }
  cleanupRecorder();
}

function cleanupRecorder() {
  if (recorder.stream) {
    recorder.stream.getTracks().forEach(t => t.stop());
    recorder.stream = null;
  }
  recorder.mediaRecorder = null;
  recorder.chunks = [];
  dom.recorderBar.setAttribute('hidden', '');
  dom.micBtn.classList.remove('recording');
  dom.recTimer.textContent = '0:00';
  if (recorder.timerInterval) {
    clearInterval(recorder.timerInterval);
    recorder.timerInterval = null;
  }
}

async function sendVoiceNote(blob, mimeType, duration) {
  if (!blob.type) blob = new Blob([blob], { type: mimeType });
  openMediaOptions(blob, duration);
}

dom.recStop.addEventListener('click', stopRecording);
dom.recCancel.addEventListener('click', cancelRecording);

// ─── Sidebar ───────────────────────────────────────────────────────────────
function closeSidebar() {
  dom.sidebar?.classList.remove('open');
}

dom.sidebarOpen?.addEventListener('click', (e) => {
  e.stopPropagation();
  dom.sidebar?.classList.toggle('open');
});

dom.sidebarClose?.addEventListener('click', closeSidebar);

document.addEventListener('click', (e) => {
  if (dom.sidebar?.classList.contains('open') &&
      !dom.sidebar.contains(e.target) &&
      !dom.sidebarOpen?.contains(e.target)) {
    closeSidebar();
  }
});

// ─── Copy Link ─────────────────────────────────────────────────────────────
function copyRoomLink() {
  const url = `${window.location.origin}/space/${state.roomId}`;
  navigator.clipboard.writeText(url).then(() => {
    showToast('Room link copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Copy failed. Link: ' + url, 'info', 5000);
  });
}

dom.copyLink?.addEventListener('click', copyRoomLink);
dom.headerCopyLink?.addEventListener('click', copyRoomLink);

// ─── Leave ─────────────────────────────────────────────────────────────────
dom.leaveBtn?.addEventListener('click', () => {
  blobUrls.forEach(url => URL.revokeObjectURL(url));
  blobUrls.clear();
  window.location.replace('/');
});

// ─── Name Modal ────────────────────────────────────────────────────────────
function showNameModal() {
  dom.loading.style.display = 'none';
  dom.nameModal.removeAttribute('hidden');
  dom.nameInput.focus();
}

dom.nameCancel.addEventListener('click', () => {
  pageIsLeaving = true;
  socket.disconnect();
  window.location.replace('/');
});

dom.nameConfirm.addEventListener('click', () => {
  const name = dom.nameInput.value.trim().replace(/[^a-zA-Z0-9_\- .]/g, '').slice(0, 30);
  if (!name) {
    dom.nameHint.textContent = 'Please enter a display name.';
    return;
  }
  dom.nameHint.textContent = '';
  sessionStorage.setItem('chyatt_name', name);
  dom.nameModal.setAttribute('hidden', '');
  dom.loading.style.display = '';
  joinRoom(name);
});

dom.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dom.nameConfirm.click();
});

// ─── Cleanup on unload ────────────────────────────────────────────────────
function cleanupPageResources() {
  blobUrls.forEach(url => URL.revokeObjectURL(url));
  blobUrls.clear();
  cancelRecording();
}

window.addEventListener('pagehide', () => {
  pageIsLeaving = true;
  socket.disconnect();
  cleanupPageResources();
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

window.addEventListener('beforeunload', cleanupPageResources);

// ─── Init ──────────────────────────────────────────────────────────────────
const roomId = getRoomIdFromPath();
if (!roomId) {
  window.location.href = '/';
}
