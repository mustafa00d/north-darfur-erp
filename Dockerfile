# نظام تقارير شمال دارفور - Dockerfile
FROM node:24-alpine

WORKDIR /app

# نسخ ملفات الإعداد والتثبيت
COPY package*.json ./
RUN npm install --omit=dev

# نسخ الكود
COPY server ./server
COPY public ./public

# مجلد البيانات (يمكن ربطه بحجم دائم من المنصة)
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server/index.js"]
