const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createStorage({ dataDir, uploadDir, inactiveDays = 7 }) {
  const stateFile = path.join(dataDir, 'wtalk-state.json');
  const inactiveMs = inactiveDays * 24 * 60 * 60 * 1000;
  let state = { users: {}, pinVoices: {} };
  let writeChain = Promise.resolve();

  async function init() {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(uploadDir, { recursive: true });
    try {
      state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      state.users ||= {};
      state.pinVoices ||= {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await persist();
    }
  }

  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain.then(async () => {
      const tempFile = `${stateFile}.tmp`;
      await fs.writeFile(tempFile, snapshot, 'utf8');
      await fs.rename(tempFile, stateFile);
    });
    return writeChain;
  }

  function userKey(channelName, username) {
    return `${channelName}\u0000${username}`;
  }

  function listUsers(channelName) {
    return Object.values(state.users)
      .filter((user) => user.channelName === channelName)
      .map((user) => ({ ...user }));
  }

  function touchUser({ channelName, username }) {
    const key = userKey(channelName, username);
    const existing = state.users[key] || {
      channelName,
      username,
      createdAt: new Date().toISOString()
    };
    existing.lastSeenAt = new Date().toISOString();
    state.users[key] = existing;
    return persist();
  }

  function getPinVoice(channelName, username) {
    return Object.values(state.pinVoices).find(
      (voice) => voice.channelName === channelName && voice.username === username
    );
  }

  function listPinVoices(channelName) {
    return Object.values(state.pinVoices)
      .filter((voice) => voice.channelName === channelName)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function publicVoice(voice) {
    if (!voice) return null;
    return {
      id: voice.id,
      channelName: voice.channelName,
      username: voice.username,
      title: voice.title,
      durationSeconds: voice.durationSeconds,
      fileSize: voice.fileSize,
      createdAt: voice.createdAt,
      updatedAt: voice.updatedAt
    };
  }

  async function createPinVoice({ channelName, username, title, durationSeconds, file }) {
    const existing = getPinVoice(channelName, username);
    if (existing) {
      const error = new Error('You already have a pinned voice message. Delete it before adding a new one.');
      error.code = 'PIN_VOICE_EXISTS';
      throw error;
    }
    const id = crypto.randomUUID();
    const extension = path.extname(file.originalname || '').toLowerCase() || '.bin';
    const fileName = `${id}${extension}`;
    const absolutePath = path.join(uploadDir, fileName);
    await fs.rename(file.path, absolutePath);
    const now = new Date().toISOString();
    const voice = {
      id,
      channelName,
      username,
      title: title.trim().slice(0, 120),
      durationSeconds: Number(durationSeconds) || 0,
      fileSize: file.size,
      mimeType: file.mimetype || 'application/octet-stream',
      fileName,
      createdAt: now,
      updatedAt: now
    };
    state.pinVoices[id] = voice;
    await persist();
    return publicVoice(voice);
  }

  async function deletePinVoice({ id, channelName, username, isAdmin = false }) {
    const voice = state.pinVoices[id];
    if (!voice || voice.channelName !== channelName) return false;
    if (!isAdmin && voice.username !== username) {
      const error = new Error('Only the voice post owner or a group admin can delete this post.');
      error.code = 'PIN_VOICE_FORBIDDEN';
      throw error;
    }
    delete state.pinVoices[id];
    await fs.rm(path.join(uploadDir, voice.fileName), { force: true });
    await persist();
    return true;
  }

  async function removeInactiveUsers() {
    const cutoff = Date.now() - inactiveMs;
    const removed = [];
    for (const [key, user] of Object.entries(state.users)) {
      if (Date.parse(user.lastSeenAt || 0) < cutoff) {
        removed.push({ ...user });
        delete state.users[key];
        for (const [voiceId, voice] of Object.entries(state.pinVoices)) {
          if (voice.channelName === user.channelName && voice.username === user.username) {
            delete state.pinVoices[voiceId];
            await fs.rm(path.join(uploadDir, voice.fileName), { force: true });
          }
        }
      }
    }
    if (removed.length) await persist();
    return removed;
  }

  function absoluteVoicePath(voice) {
    return path.join(uploadDir, voice.fileName);
  }

  function getVoice(id) {
    return state.pinVoices[id] || null;
  }

  return {
    init,
    persist,
    touchUser,
    listUsers,
    getPinVoice,
    listPinVoices,
    publicVoice,
    createPinVoice,
    deletePinVoice,
    removeInactiveUsers,
    absoluteVoicePath,
    getVoice
  };
}

module.exports = { createStorage };
