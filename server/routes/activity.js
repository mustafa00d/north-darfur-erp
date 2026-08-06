import express from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();

router.get('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { action, limit } = req.query;
  const maxLimit = Math.min(parseInt(limit) || 100, 500);

  let sql = 'SELECT * FROM activity_log';
  const params = {};
  if (action) {
    sql += ' WHERE action LIKE @a';
    params.a = `%${action}%`;
  }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT @limit';
  params.limit = maxLimit;

  const rows = await db.all(sql, params);
  res.json(rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: row.details,
    createdAt: row.created_at
  })));
}));

export default router;
