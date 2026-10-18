// ============================================================
// landing.js — fchat Landing Page Logic
// ============================================================

'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────
const createBtn = document.getElementById('js-create-btn');
const joinBtn = document.getElementById('js-join-btn');
const roomInput = document.getElementById('js-room-input');
const joinHint = document.getElementById('js-join-hint');
const nameModal = document.getElementById('js-name-modal');
const nameInput = document.getElementById('js-name-input');
const nameHint = document.getElementById('js-name-hint');
const modalConfirm = document.getElementById('js-modal-confirm');

// ── State ─────────────────────────────────────────────────────────────────
let pendingRoomId = null;

// ── XSS Sanitizer (client-side, minimal) ─────────────────────────────────
function sanitizeInput(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .trim();
}

// ── Extract room ID from URL or plain text ────────────────────────────────
function extractRoomId(input) {
  const trimmed = input.trim();
  // If it's a URL, extract the pathname segment
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/space\/([\w-]+)/);
    if (match) return match[1];
  } catch (_) {
    // Not a URL — treat as plain ID
  }
  // Validate plain room ID (lowercase letters, numbers, hyphens)
  if (/^[a-z0-9-]{3,50}$/.test(trimmed)) return trimmed;
  return null;
}

// ── Show name modal then navigate ─────────────────────────────────────────
function openNameModal(roomId) {
  pendingRoomId = roomId;
  nameModal.removeAttribute('hidden');
  nameInput.value = sessionStorage.getItem('chyatt_name') || sessionStorage.getItem('fchat_name') || '';
  nameInput.focus();
}

function closeNameModal() {
  nameModal.setAttribute('hidden', '');
  pendingRoomId = null;
}

function proceedToRoom() {
  const name = nameInput.value.trim().replace(/[^a-zA-Z0-9_\- .]/g, '').slice(0, 30);
  if (!name) {
    nameHint.textContent = 'Please enter a display name.';
    nameInput.focus();
    return;
  }
  nameHint.textContent = '';
  sessionStorage.setItem('chyatt_name', name);
  window.location.href = `/space/${pendingRoomId}`;
}

// ── Create Space ──────────────────────────────────────────────────────────
createBtn.addEventListener('click', async () => {
  createBtn.disabled = true;
  createBtn.textContent = 'Creating...';
  try {
    const res = await fetch('/api/create-room');
    if (!res.ok) throw new Error('Server error');
    const { roomId } = await res.json();
    openNameModal(roomId);
  } catch (err) {
    showToast('Failed to create space. Try again.', 'error');
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = 'Create Space';
  }
});

// ── Join Space ────────────────────────────────────────────────────────────
function attemptJoin() {
  const rawInput = roomInput.value;
  if (!rawInput.trim()) {
    joinHint.textContent = 'Please enter a Space ID or URL.';
    roomInput.focus();
    return;
  }

  const roomId = extractRoomId(rawInput);
  if (!roomId) {
    joinHint.textContent = 'Invalid Space ID format. Use letters, numbers, and hyphens.';
    return;
  }
  joinHint.textContent = '';
  openNameModal(roomId);
}

joinBtn.addEventListener('click', attemptJoin);
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptJoin();
});

// ── Modal controls ────────────────────────────────────────────────────────
modalConfirm.addEventListener('click', proceedToRoom);

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') proceedToRoom();
});

nameModal.addEventListener('click', (e) => {
  if (e.target === nameModal) closeNameModal();
});

// ── Handle direct /space/:id URLs visited from index ─────────────────────
const pathMatch = window.location.pathname.match(/^\/space\/([\w-]+)$/);
if (pathMatch) {
  openNameModal(pathMatch[1]);
}

// ── Toast helper ──────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('js-toast');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Animate room input focus ──────────────────────────────────────────────
roomInput.addEventListener('focus', () => {
  (roomInput.closest('.action-card') || roomInput.closest('.card'))?.classList.add('focused');
});
roomInput.addEventListener('blur', () => {
  (roomInput.closest('.action-card') || roomInput.closest('.card'))?.classList.remove('focused');
});

// ── Paste detection: auto-clean URL ──────────────────────────────────────
roomInput.addEventListener('paste', (e) => {
  setTimeout(() => {
    const pasted = roomInput.value;
    const extracted = extractRoomId(pasted);
    if (extracted && extracted !== pasted.trim()) {
      roomInput.value = extracted;
      joinHint.textContent = `Room ID extracted: ${extracted}`;
      setTimeout(() => { joinHint.textContent = ''; }, 3000);
    }
  }, 50);
});
