import 'dotenv/config';
import app from './app.js';
import { init } from './db.js';

const PORT = process.env.PORT || 3001;

await init();

app.listen(PORT, () => {
  console.log(`✔ نظام تقارير شمال دارفور يعمل على http://localhost:${PORT}`);
  console.log(`✔ لوحة الإدارة: http://localhost:${PORT}/admin.html`);
  console.log(`✔ صفحة إدخال البيانات: http://localhost:${PORT}/user.html`);
});
