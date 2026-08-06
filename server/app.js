import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/auth.js';
import metaRoutes from './routes/meta.js';
import reportRoutes from './routes/reports.js';
import userRoutes from './routes/users.js';
import settingsRoutes from './routes/settings.js';
import analyticsRoutes from './routes/analytics.js';
import activityRoutes from './routes/activity.js';
import notificationRoutes from './routes/notifications.js';
import shareRoutes from './routes/share.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// حماية أساسية (Security Headers) بدون تفعيل CSP حتى لا يمنع سكربتات الواجهة الداخلية
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  next();
});

// تحديد معدل محاولات تسجيل الدخول (حماية من القوة العمياء)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة، حاول بعد 15 دقيقة' }
});
app.use('/api/auth/login', loginLimiter);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/users', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/share', shareRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Static frontend
app.use(express.static(publicDir));
app.get(/^\/(index|user|admin)?$/, (req, res) => {
  const page = req.path.replace(/\//g, '') || 'index';
  const file = path.join(publicDir, `${page}.html`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.redirect('/index.html');
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'خطأ في الخادم | Server error' });
});

export default app;
