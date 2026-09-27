const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

function createPinVoiceRouter({ storage, uploadDir, maxBytes = 5 * 1024 * 1024, io }) {
  const router = express.Router();
  const tempDir = path.join(uploadDir, '.tmp');
  fs.mkdirSync(tempDir, { recursive: true });
  const upload = multer({
    dest: tempDir,
    limits: { fileSize: maxBytes },
    fileFilter: (_req, file, callback) => {
      const allowed = ['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav'];
      callback(null, allowed.includes(file.mimetype));
    }
  });

  function requireChannelAccess(req, res, next) {
    const channelName = String(req.body.channelName || req.query.channelName || '').trim();
    const username = String(req.body.username || req.query.username || '').trim();
    if (!channelName || !username) return res.status(400).json({ error: 'channelName and username are required' });
    req.channelName = channelName;
    req.username = username;
    next();
  }

  router.get('/', requireChannelAccess, (_req, res) => {
    res.json({ items: storage.listPinVoices(_req.channelName).map(storage.publicVoice) });
  });

  router.post('/', upload.single('audio'), requireChannelAccess, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'audio file is required' });
    const title = String(req.body.title || '').trim();
    if (!title) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ error: 'title is required' });
    }
    try {
      const item = await storage.createPinVoice({
        channelName: req.channelName,
        username: req.username,
        title,
        durationSeconds: req.body.durationSeconds,
        file: req.file
      });
      io?.to(req.channelName).emit('pin_voice_created', { item });
      res.status(201).json({ item });
    } catch (error) {
      fs.rmSync(req.file.path, { force: true });
      if (error.code === 'PIN_VOICE_EXISTS') return res.status(409).json({ error: error.message });
      throw error;
    }
  });

  router.delete('/:id', requireChannelAccess, async (req, res) => {
    try {
      const deleted = await storage.deletePinVoice({
        id: req.params.id,
        channelName: req.channelName,
        username: req.username,
        isAdmin: req.get('x-wtalk-admin') === 'true'
      });
      if (!deleted) return res.status(404).json({ error: 'pinned voice message not found' });
      io?.to(req.channelName).emit('pin_voice_deleted', { id: req.params.id });
      res.status(204).end();
    } catch (error) {
      if (error.code === 'PIN_VOICE_FORBIDDEN') return res.status(403).json({ error: error.message });
      throw error;
    }
  });

  router.get('/:id/stream', requireChannelAccess, (req, res) => {
    const voice = storage.getVoice(req.params.id);
    if (!voice || voice.channelName !== req.channelName) return res.status(404).end();
    const filePath = storage.absoluteVoicePath(voice);
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'audio file is no longer available' });
    const size = fs.statSync(filePath).size;
    const range = req.headers.range;
    res.setHeader('Content-Type', voice.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (!range) {
      res.setHeader('Content-Length', size);
      return fs.createReadStream(filePath).pipe(res);
    }
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) return res.status(416).end();
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : size - 1;
    if (start >= size || end < start) return res.status(416).end();
    const safeEnd = Math.min(end, size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${size}`);
    res.setHeader('Content-Length', safeEnd - start + 1);
    fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
  });

  return router;
}

module.exports = { createPinVoiceRouter };
