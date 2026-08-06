import express from 'express';
import db from '../db.js';
import { requireAuth } from '../auth.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.all(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50',
    [req.user.id]
  );
  res.json(rows.map(n => ({
    id: n.id,
    title: n.title,
    message: n.message,
    type: n.type,
    read: !!n.read,
    createdAt: n.created_at
  })));
}));

router.get('/unread-count', asyncHandler(async (req, res) => {
  const row = await db.get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0', [req.user.id]);
  res.json({ count: row.c });
}));

router.post('/read-all', asyncHandler(async (req, res) => {
  await db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', [req.user.id]);
  res.json({ success: true });
}));

router.post('/:id/read', asyncHandler(async (req, res) => {
  await db.run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

export default router;
