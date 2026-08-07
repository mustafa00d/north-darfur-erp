import { Router } from 'express';
import { runMondayJob } from '../cron.js';

const router = Router();

router.post('/monday', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET غير مضبوط في الخادم' });
  if ((req.headers['x-cron-secret'] || '') !== secret) {
    return res.status(401).json({ error: 'غير مصرح | Unauthorized' });
  }
  try {
    const result = await runMondayJob();
    res.json(result);
  } catch (err) {
    console.error('[CRON] خطأ في المهمة:', err);
    res.status(500).json({ error: 'فشلت المهمة الأسبوعية' });
  }
});

export default router;
