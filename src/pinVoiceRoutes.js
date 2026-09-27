const express = require('express');
const multer = require('multer');

function createPinVoiceRouter({ storage, maxBytes = 5 * 1024 * 1024, io }) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
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

  router.get('/', requireChannelAccess, async (req, res, next) => {
    try {
      res.json({ items: await storage.listPinVoices(req.channelName) });
    } catch (error) { next(error); }
  });

  router.post('/', upload.single('audio'), requireChannelAccess, async (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'audio file is required' });
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title is required' });
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
      if (error.code === 'PIN_VOICE_EXISTS') return res.status(409).json({ error: error.message });
      next(error);
    }
  });

  router.delete('/:id', requireChannelAccess, async (req, res, next) => {
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
      next(error);
    }
  });

  router.get('/:id/stream', requireChannelAccess, async (req, res, next) => {
    try {
      const voice = await storage.getPinVoice(req.params.id);
      if (!voice || voice.channel_name !== req.channelName) return res.status(404).end();
      const signedUrl = await storage.createSignedStreamUrl(voice, 120);
      res.redirect(302, signedUrl);
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createPinVoiceRouter };
