import db from './db.js';

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

export function geminiUrl(model, key) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
}

export async function getSetting(key) {
  const row = await db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  await db.run(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

export async function isAiEnabled() {
  return !!(await getSetting('gemini_api_key'));
}

export async function maskKey(key) {
  if (!key) return '';
  return key.slice(0, 4) + '••••••••' + key.slice(-4);
}

async function callGemini(systemPrompt, userText, maxRetries = 2) {
  const key = await getSetting('gemini_api_key');
  if (!key) return null;
  const body = {
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
  };
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(geminiUrl(model, key), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(25000)
        });
        if (!res.ok) {
          if (res.status === 404) break;
          if (res.status === 429 || res.status >= 500) continue;
          return null;
        }
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || null;
        if (text) return text;
      } catch (e) {
        continue;
      }
    }
  }
  return null;
}

async function parseJsonBlock(text) {
  if (!text) return null;
  const match = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// ==================== قواعد تدقيق التقرير ====================

export async function runChecks(row, extra = {}) {
  const checks = [];
  const push = (level, label, detail) => checks.push({ level, label, detail });

  const total = Number(row.beneficiaries_total) || 0;
  const male = Number(row.beneficiaries_male) || 0;
  const female = Number(row.beneficiaries_female) || 0;
  const amount = Number(row.amount_received) || 0;

  if (total !== male + female) {
    push('error', 'عدم تطابق المستفيدين',
      `الإجمالي (${total}) لا يساوي ذكور (${male}) + إناث (${female}) = ${male + female}`);
  }
  if (total === 0) {
    push('warn', 'صفر مستفيدين', 'عدد المستفيدين صفر — تحقق من صحة الرقم');
  }
  if (amount === 0) {
    push('warn', 'صفر مبلغ', 'المبلغ المستلم صفر — تأكد أو اشرح السبب في الوصف');
  }
  const challenges = (row.challenges || '').trim();
  const outcomes = (row.positive_outcomes || '').trim();
  if (challenges.length < 20) {
    push('warn', 'التحديات ناقصة', `نص التحديات قصير جداً (${challenges.length} حرفاً) — اذكر تفاصيل أكثر`);
  }
  if (outcomes.length < 20) {
    push('warn', 'النتائج ناقصة', `نص النتائج قصير جداً (${outcomes.length} حرفاً) — اذكر نتائج واضحة`);
  }
  if (!row.support_description || String(row.support_description).trim().length < 5) {
    push('info', 'لا وصف للدعم', 'أضف وصفاً قصيراً لطبيعة الدعم المقدم');
  }

  if (extra.localityAvg && extra.localityAvg.n > 1) {
    const ratio = amount / (extra.localityAvg.avg || 1);
    if (ratio > 8) {
      push('warn', 'مبلغ شاذ مقارنة بالمحلية',
        `المبلغ (${amount.toLocaleString('en')}) أعلى بـ ${ratio.toFixed(1)}× من متوسط محلية ${extra.localityAvg.localityAr} (${extra.localityAvg.avg.toLocaleString('en')})`);
    }
  }
  if (extra.donorAvg && extra.donorAvg.n > 1) {
    const ratio = amount / (extra.donorAvg.avg || 1);
    if (ratio > 8) {
      push('warn', 'مبلغ شاذ مقارنة بالمانح',
        `المبلغ أعلى بـ ${ratio.toFixed(1)}× من متوسط منح ${extra.donorAvg.donorName}`);
    }
  }
  if (extra.sameRoomCount && extra.sameRoomCount > 3) {
    push('info', 'غرفة نشطة', `سجّلت الغرفة ${extra.sameRoomCount} تقارير هذا العام — تحقق من عدم التكرار المقصود`);
  }

  return checks;
}

export async function reviewAssist(row) {
  const [localityAvg, donorAvg, sameRoomCount] = await Promise.all([
    db.get(
      `SELECT AVG(amount_received) AS avg, COUNT(*) AS n, l.name_ar AS localityAr
       FROM reports r JOIN localities l ON l.id = r.locality_id
       WHERE r.locality_id = ? AND r.id != ? AND r.amount_received > 0`,
      [row.locality_id, row.id]
    ),
    db.get(
      `SELECT AVG(amount_received) AS avg, COUNT(*) AS n, d.name AS donorName
       FROM reports r JOIN donors d ON d.id = r.donor_id
       WHERE r.donor_id = ? AND r.id != ? AND r.amount_received > 0`,
      [row.donor_id, row.id]
    ),
    db.get(
      `SELECT COUNT(*) AS c FROM reports
       WHERE LOWER(TRIM(err_name)) = LOWER(TRIM(?)) AND year = ? AND id != ?`,
      [row.err_name, row.year, row.id]
    )
  ]);

  const checks = await runChecks(row, {
    localityAvg: localityAvg && localityAvg.n ? { ...localityAvg, n: Number(localityAvg.n) } : null,
    donorAvg: donorAvg && donorAvg.n ? { ...donorAvg, n: Number(donorAvg.n) } : null,
    sameRoomCount: Number(sameRoomCount?.c || 0)
  });

  const errors = checks.filter(c => c.level === 'error');
  const warns = checks.filter(c => c.level === 'warn');

  let verdict = 'needs_review';
  let confidence = 60;
  if (errors.length) {
    verdict = 'reject';
    confidence = 90;
  } else if (warns.length === 0) {
    verdict = 'approve';
    confidence = 85;
  } else if (warns.length <= 2) {
    verdict = 'approve';
    confidence = 70;
  }

  const result = {
    verdict,
    confidence,
    source: 'rules',
    checks,
    summary: errors.length
      ? `يحتوي التقرير على ${errors.length} خطأ جوهري يجب تصحيحه قبل الاعتماد`
      : warns.length
        ? `التقرير سليم جوهرياً مع ${warns.length} ملاحظة ينصح بمعالجتها (موافقة بمراجعة سريعة)`
        : 'التقرير مكتمل ومتسق — ينصح بالموافقة',
    suggestedNote: errors.length ? 'يرجى تصحيح الأخطاء التالية ثم إعادة الإرسال: ' + errors.map(e => e.label).join('، ')
      : (warns.length ? 'ملاحظات قبل الاعتماد: ' + warns.map(w => w.label).join('، ') : '')
  };

  // تحسين بجودة LLM إن توفر المفتاح
  const llm = await askGeminiForReview(row, checks);
  if (llm) {
    result.source = 'llm';
    result.summary = llm.summary || result.summary;
    result.suggestedNote = llm.suggestedNote || result.suggestedNote;
    if (['approve', 'reject', 'needs_review'].includes(llm.verdict)) {
      result.verdict = llm.verdict;
      result.confidence = Number(llm.confidence) || result.confidence;
    }
  }
  return result;
}

async function askGeminiForReview(row, checks) {
  const reportText = [
    `غرفة: ${row.err_name} (السنة ${row.year}، الشهر ${row.month_id})`,
    `المحلية: ${row.locality_ar || row.locality_id} | المانح: ${row.donor_name || row.donor_id} | الشريك: ${row.partner_name || row.partner_id}`,
    `المبلغ: ${row.amount_received} | المستفيدون: ${row.beneficiaries_total} (ذكور ${row.beneficiaries_male}، إناث ${row.beneficiaries_female})`,
    `التحديات: ${row.challenges}`,
    `النتائج: ${row.positive_outcomes}`,
    `وصف الدعم: ${row.support_description || ''}`
  ].join('\n');
  const checksText = checks.map((c, i) => `${i + 1}. [${c.level}] ${c.label}: ${c.detail}`).join('\n') || 'لا توجد ملاحظات';
  const text = `قرار مقترح (موافقة/رفض/مراجعة) مع درجة ثقة 0-100، وملخص عربي مختصر، وملاحظة اقتراحية للمراجع.\nأجب JSON فقط: {"verdict":"approve|reject|needs_review","confidence":0-100,"summary":"نص عربي","suggestedNote":"نص عربي"}\n\nالتقرير:\n${reportText}\n\nنتائج التدقيق الآلي:\n${checksText}`;
  const raw = await callGemini('أنت مدقق تقارير إنسانية محترف في شمال دارفور. راجع اكتمال التقرير واتساقه وملاءمته، وأعطِ توصية مبدئية فقط — القرار النهائي للمراجع البشري.', text);
  return parseJsonBlock(raw);
}

// ==================== مساعد المحادثة ====================

export async function chatAnswer(user, message) {
  const q = String(message || '').trim();
  if (!q) return { reply: 'اكتب سؤالك عن النظام بالعربية.', source: 'rules' };

  const has = (...words) => words.some(w => q.includes(w));

  const intents = [
    {
      keys: ['إحصائي', 'تحليل', 'كم', 'عدد', 'مستفيد', 'مبلغ', 'مجموع'],
      handler: async () => {
        const stats = await db.get(
          `SELECT COUNT(*) AS c, COALESCE(SUM(beneficiaries_total), 0) AS ben,
                  COALESCE(SUM(amount_received), 0) AS amt FROM reports WHERE user_id = ?`,
          [user.id]
        );
        return {
          reply: `سجّلت حتى الآن ${stats.c} تقريراً، بمجموع ${Number(stats.ben).toLocaleString('en')} مستفيداً ومبلغ ${Number(stats.amt).toLocaleString('en')}.`,
          source: 'rules'
        };
      }
    },
    {
      keys: ['اضيف', 'إضافة', 'ارسل', 'إرسال', 'تسجيل'],
      handler: async () => ({
        reply: 'لإضافة تقرير: من صفحتك الرئيسية اضغط «إضافة تقرير جديد» ثم عبّئ البيانات: اسم الغرفة، المحلية، المانح، نوع الدعم، الشهر والسنة، المبلغ والمستفيدين، ثم التحديات والنتائج. ستصلك رسالة تأكيد برقم مرجعي يبدأ بـ ND-.',
        source: 'rules'
      })
    },
    {
      keys: ['مرفوض', 'رفض', 'اعتمد', 'موافقة', 'قبول'],
      handler: async () => ({
        reply: 'إذا رُفض تقريرك: افتحه واقرأ سبب الرفض، ثم اضغط «تعديل» لتصحيح الأخطاء، ثم «إعادة إرسال». يمكنك تعديل التقارير المرفوضة أو غير المعتمدة فقط.',
        source: 'rules'
      })
    },
    {
      keys: ['مشاركة', 'شريك', 'رابط', 'مانح خارجي', 'عرض'],
      handler: async () => ({
        reply: 'روابط المشاركة يلّنشئها المدير من لوحة التحكم، وهي تعرض إحصائيات إجمالية للجهات المانحة الخارجية بدون أسماء الموظفين، مع كلمة مرور اختيارية وانتهاء صلاحية.',
        source: 'rules'
      })
    },
    {
      keys: ['كلمة', 'مرور', 'password', 'نسيت'],
      handler: async () => ({
        reply: 'إذا نسيت كلمة المرور اطلب من مدير النظام إعادة تعيينها. عند تغيير المدير لكلمة مرورك ستُطلب منك كلمة جديدة عند أول دخول.',
        source: 'rules'
      })
    },
    {
      keys: ['سنة', 'رقم', 'مرجع', 'ND-'],
      handler: async () => ({
        reply: 'كل تقرير يحصل على رقم مرجعي تلقائي بصيغة ND-السنة-0001، ويتصاعد ضمن نفس السنة. عند تغيير سنة التقرير يُولَّد رقم جديد.',
        source: 'rules'
      })
    }
  ];

  for (const it of intents) {
    if (has(...it.keys)) {
      try { return await it.handler(); } catch { break; }
    }
  }

  // ذكاء LLM إن توفر
  const llm = await callGemini(
    'أنت مساعد نظام تقارير غرف الطوارئ شمال دارفور. أجب باختصار (3-5 أسطر) بالعربية وبطريقة ودية.',
    `سؤال من المستخدم ${user.name} (${user.role}): ${q}`
  );
  if (llm) return { reply: llm.trim(), source: 'llm' };

  return {
    reply: 'لم أفهم سؤالك تماماً. جرب أسئلة مثل: «كيف أضيف تقريراً؟» أو «ماذا أفعل بتقرير مرفوض؟» أو «كم تقريراً سجّلت؟».',
    source: 'rules'
  };
}

// ==================== التحليل التلقائي ====================

export async function analysisSummary(params = {}) {
  const year = params.year || new Date().getFullYear();
  const monthId = params.monthId ? parseInt(params.monthId) : null;
  const where = ['r.year = @yr'];
  const p = { yr: year };
  if (monthId) { where.push('r.month_id = @mo'); p.mo = monthId; }
  const w = where.join(' AND ');

  const [stats, byLocality, byDonor, bySector] = await Promise.all([
    db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              COALESCE(SUM(beneficiaries_total), 0) AS beneficiaries,
              COALESCE(SUM(beneficiaries_female), 0) AS female,
              COALESCE(SUM(amount_received), 0) AS amount
       FROM reports r WHERE ${w}`,
      p
    ),
    db.all(
      `SELECT l.name_ar AS name, COUNT(*) AS c, COALESCE(SUM(r.amount_received), 0) AS amount
       FROM reports r JOIN localities l ON l.id = r.locality_id
       WHERE ${w} GROUP BY l.id ORDER BY c DESC LIMIT 5`,
      p
    ),
    db.all(
      `SELECT d.name AS name, COUNT(*) AS c, COALESCE(SUM(r.amount_received), 0) AS amount
       FROM reports r JOIN donors d ON d.id = r.donor_id
       WHERE ${w} GROUP BY d.id ORDER BY amount DESC LIMIT 5`,
      p
    ),
    db.all(
      `SELECT s.name_ar AS name, COUNT(*) AS c
       FROM reports r JOIN support_types s ON s.id = r.support_type_id
       WHERE ${w} GROUP BY s.id ORDER BY c DESC LIMIT 5`,
      p
    )
  ]);

  const s = {
    total: Number(stats.total || 0), approved: Number(stats.approved || 0),
    pending: Number(stats.pending || 0), rejected: Number(stats.rejected || 0),
    beneficiaries: Number(stats.beneficiaries || 0), female: Number(stats.female || 0),
    amount: Number(stats.amount || 0),
    femaleRatio: stats.total ? Math.round((Number(stats.female || 0) / Number(stats.beneficiaries || 1)) * 100) : 0,
    approvalRate: stats.total ? Math.round((Number(stats.approved || 0) / Number(stats.total)) * 100) : 0
  };

  const result = { year, monthId, stats: s, byLocality, byDonor, bySector, narrative: null, source: 'rules' };

  const llm = await askGeminiForSummary(s, byLocality, byDonor, bySector, year, monthId);
  if (llm) {
    result.narrative = llm;
    result.source = 'llm';
  } else if (s.total > 0) {
    const topLoc = byLocality[0];
    const topSector = bySector[0];
    result.narrative =
      `خلال ${monthId ? 'شهر ' + monthId + ' من ' : ''}عام ${year} سُجّلت ${s.total} تقارير، واعتُمد ${s.approved} منها (نسبة اعتماد ${s.approvalRate}%)، استفاد منها ${s.beneficiaries.toLocaleString('en')} شخصاً (نسبة الإناث ${s.femaleRatio}%) بمبلغ إجمالي ${s.amount.toLocaleString('en')}. ` +
      (topLoc ? `المحلية الأكثر نشاطاً: ${topLoc.name} (${topLoc.c} تقرير). ` : '') +
      (topSector ? `أكثر القطاعات استفادة: ${topSector.name}.` : '');
  } else {
    result.narrative = 'لا توجد تقارير في هذه الفترة بعد.';
  }

  return result;
}

async function askGeminiForSummary(s, byLocality, byDonor, bySector, year, monthId) {
  const text = `اكتب فقرة تحليلية عربية (5-8 أسطر) عن نشاط غرف الطوارئ، بلهجة رسمية مناسبة للجهات المانحة، تتضمن: الحجم والأرقام الأساسية، الاتجاهات، الأنشطة الأبرز، وملاحظات احترافية قصيرة عن التحديات المحتملة.\nالأرقام: ${JSON.stringify(s)}\nالمحليات: ${JSON.stringify(byLocality)}\nالمانحون: ${JSON.stringify(byDonor)}\nالقطاعات: ${JSON.stringify(bySector)}\nالفترة: ${year}${monthId ? ' شهر ' + monthId : ''}`;
  return callGemini('أنت محلل بيانات إغاثة إنسانية خبير، تكتب ملخصات عربية واضحة وقصيرة.', text);
}

export { callGemini, parseJsonBlock };
