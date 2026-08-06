import db from './db.js';

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

// كابح الدائرة: عند فشل الحصة (429/400/403) لا نستدعي Gemini مجدداً لمدة 5 دقائق
let llmOfflineUntil = 0;

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

async function callGemini(systemPrompt, userText, maxRetries = 1) {
  const key = await getSetting('gemini_api_key');
  if (!key) return null;
  if (Date.now() < llmOfflineUntil) return null;
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
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) {
          if (res.status === 404) break;
          if (res.status === 429 || res.status === 403 || res.status === 400) {
            llmOfflineUntil = Date.now() + 5 * 60 * 1000;
            return null;
          }
          if (res.status >= 500) continue;
          return null;
        }
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || null;
        if (text) return text;
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          llmOfflineUntil = Date.now() + 5 * 60 * 1000;
          return null;
        }
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

function fmt(n) {
  return Number(n || 0).toLocaleString('en');
}

export async function chatAnswer(user, message) {
  const q = String(message || '').trim();
  if (!q) return { reply: 'اكتب سؤالك عن النظام بالعربية.', source: 'rules' };

  const has = (...words) => words.some(w => q.includes(w));
  const isAdmin = user.role === 'admin';
  const isLoc = user.role === 'locality_admin';

  // إحصائيات مدركة للدور
  async function statsFor(whereSql, params) {
    const row = await db.get(
      `SELECT COUNT(*) AS c,
              SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS pending,
              COALESCE(SUM(beneficiaries_total), 0) AS ben,
              COALESCE(SUM(beneficiaries_female), 0) AS female,
              COALESCE(SUM(amount_received), 0) AS amt
       FROM reports r ${whereSql}`,
      params
    );
    return {
      c: Number(row.c || 0), approved: Number(row.approved || 0), pending: Number(row.pending || 0),
      ben: Number(row.ben || 0), female: Number(row.female || 0), amt: Number(row.amt || 0)
    };
  }

  const intents = [
    // إحصائيات النظام / المحلية / الشخصية
    {
      keys: ['إجمالي', 'النظام', 'الكل', 'جميع'],
      handler: async () => {
        const s = await statsFor('', {});
        const femaleRatio = s.ben ? Math.round(s.female / s.ben * 100) : 0;
        return {
          reply: `إجمالي النظام: ${fmt(s.c)} تقريراً (معتمد ${s.approved}، قيد المراجعة ${s.pending})، بمجموع ${fmt(s.ben)} مستفيداً (نسبة الإناث ${femaleRatio}%) ومبلغ ${fmt(s.amt)}.`,
          source: 'rules'
        };
      }
    },
    {
      keys: ['كم', 'عدد', 'مستفيد', 'مبلغ', 'مجموع', 'إحصائي', 'تحليل', 'حسابي'],
      handler: async () => {
        if (isAdmin) {
          const s = await statsFor('', {});
          const femaleRatio = s.ben ? Math.round(s.female / s.ben * 100) : 0;
          return {
            reply: `سُجّلت في النظام ${fmt(s.c)} تقريراً (معتمد ${fmt(s.approved)}، قيد المراجعة ${fmt(s.pending)})، استفاد منها ${fmt(s.ben)} شخصاً (نسبة الإناث ${femaleRatio}%) بمبلغ إجمالي ${fmt(s.amt)}.`,
            source: 'rules'
          };
        }
        if (isLoc) {
          const s = await statsFor('WHERE r.locality_id = ?', [user.locality_id]);
          return {
            reply: `سُجّلت في محليتك ${fmt(s.c)} تقريراً (معتمد ${fmt(s.approved)}، قيد المراجعة ${fmt(s.pending)})، بمجموع ${fmt(s.ben)} مستفيداً ومبلغ ${fmt(s.amt)}.`,
            source: 'rules'
          };
        }
        const s = await statsFor('WHERE r.user_id = ?', [user.id]);
        return {
          reply: `سجّلت حتى الآن ${fmt(s.c)} تقريراً (معتمد ${fmt(s.approved)}، قيد المراجعة ${fmt(s.pending)})، بمجموع ${fmt(s.ben)} مستفيداً ومبلغ ${fmt(s.amt)}.`,
          source: 'rules'
        };
      }
    },
    {
      keys: ['اضيف', 'إضافة', 'ارسل', 'إرسال', 'تسجيل', 'أضيف', 'أسجل'],
      handler: async () => ({
        reply: 'لإضافة تقرير: من صفحتك الرئيسية اضغط «إضافة تقرير جديد» ثم عبّئ البيانات: اسم الغرفة، المحلية، المانح، نوع الدعم، الشهر والسنة، المبلغ والمستفيدين، ثم التحديات والنتائج. ستصلك رسالة تأكيد برقم مرجعي يبدأ بـ ND-. تأكد أن مجموع الذكور والإناث يساوي الإجمالي.',
        source: 'rules'
      })
    },
    {
      keys: ['مرفوض', 'رفض', 'أرفض', 'ارفض'],
      handler: async () => ({
        reply: 'إذا رُفض تقريرك: افتحه من قائمة تقاريري واقرأ سبب الرفض، ثم اضغط «تعديل» لتصحيح الأخطاء المذكورة، ثم «إعادة إرسال». يمكنك تعديل أي تقرير غير معتمد بعد.',
        source: 'rules'
      })
    },
    {
      keys: ['مراجعة', 'موافقة', 'اعتماد', 'مين', 'من يوافق', 'دوري', 'مسؤوليتي', 'مسؤول'],
      handler: async () => {
        if (isLoc) {
          return {
            reply: 'دورك كمشرف محلية: مراجعة تقارير محليتك فقط من قسم «مراجعة تقارير محليتي» — إما موافقة أو رفض مع ذكر السبب. التقارير خارج محليتك تظهر للمدير العام.',
            source: 'rules'
          };
        }
        if (isAdmin) {
          return {
            reply: 'دورك كمدير: الموافقة النهائية على جميع التقارير، وإدارة المستخدمين والمحليات والمشاركة والنسخ الاحتياطي. زر «مساعدة الذكاء» في تفاصيل أي تقرير يعطيك توصية أولية بملاحظات التدقيق.',
            source: 'rules'
          };
        }
        return {
          reply: 'بعد إرسالك التقرير يراجعه مشرف محليتك ثم المدير العام. ستصلك إشعارات بحالة كل تقرير، ويمكنك تصحيح المرفوض وإعادة إرساله.',
          source: 'rules'
        };
      }
    },
    {
      keys: ['مشاركة', 'رابط', 'مانح خارجي', 'عرض', 'شريك'],
      handler: async () => ({
        reply: isAdmin
          ? 'أنشئ رابط مشاركة من تبويب «المشاركة»: اسم الرابط + مدة الصلاحية + المحتوى، مع كلمة مرور اختيارية. الرابط يعرض بيانات مجمعة للجهات الخارجية دون أسماء الموظفين، ويمكنك حذفه في أي وقت.'
          : 'روابط المشاركة ينشئها المدير من لوحة التحكم، وهي تعرض إحصائيات مجمعة للجهات المانحة الخارجية مع كلمة مرور اختيارية وانتهاء صلاحية.',
        source: 'rules'
      })
    },
    {
      keys: ['كلمة', 'مرور', 'password', 'نسيت'],
      handler: async () => ({
        reply: 'لا يمكن تغيير كلمة المرور ذاتياً حالياً — اطلب من مدير النظام إعادة تعيينها. عند إعادة التعيين ستُطلب منك كلمة جديدة عند أول دخول.',
        source: 'rules'
      })
    },
    {
      keys: ['رقم', 'مرجع', 'ND-', 'كود'],
      handler: async () => ({
        reply: 'كل تقرير يحصل على رقم مرجعي تلقائي بصيغة ND-السنة-0001 يتصاعد ضمن نفس السنة، ويظهر في قائمتك وفي رسالة التأكيد. عند تغيير سنة التقرير يُولَّد رقم جديد تلقائياً.',
        source: 'rules'
      })
    },
    {
      keys: ['صدّر', 'تصدير', 'PDF', 'CSV', 'اكسل', 'ملف', 'طباعة'],
      handler: async () => ({
        reply: isAdmin
          ? 'من تبويب «التقارير» يمكنك تصدير كل ما تراه: زر «تصدير Excel» ينتج ملف CSV، وزر «PDF» ينتج تقريراً مطبوعاً يتضمن الإجماليات، بالإضافة لنسخة احتياطية JSON من تبويب الإعدادات.'
          : 'التصدير (Excel/PDF) متاح لمدير النظام من تبويب التقارير.',
        source: 'rules'
      })
    },
    {
      keys: ['نسخة', 'احتياط', 'استعادة', 'نسخ'],
      handler: async () => ({
        reply: isAdmin
          ? 'من تبويب «الإعدادات» → «النسخ الاحتياطي»: زر التصدير يحفظ نسخة JSON كاملة (تتضمن بيانات المستخدمين)، وزر الاستعادة يعيدها كاملة — انتبه: الاستعادة تستبدل كل البيانات الحالية.'
          : 'النسخ الاحتياطي من صلاحيات مدير النظام فقط (تبويب الإعدادات).',
        source: 'rules'
      })
    },
    {
      keys: ['إشعار', 'تنبيه', 'رسالة'],
      handler: async () => ({
        reply: 'تظهر إشعاراتك في الجرس أعلى الصفحة: تقرير جديد، موافقة، رفض مع السبب. تُحدَّث تلقائياً كل دقيقة.',
        source: 'rules'
      })
    },
    {
      keys: ['محلية', 'غرفة', 'جديدة', 'إضافة محلية'],
      handler: async () => ({
        reply: isAdmin
          ? 'المحليات والغرف تُدار من تبويب «الإعدادات»: أضف محلية بالاسم العربي والإنجليزي واللون، والغرفة تُكتب يدوياً في استمارة التقرير (اسم غرفة الطوارئ).'
          : 'أسماء الغرف تُكتب يدوياً في استمارة التقرير (حقل اسم غرفة الطوارئ)، والمحليات يحددها المدير.',
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
    'أنت مساعد نظام تقارير غرف الطوارئ بشمال دارفور. أجب باختصار (3-5 أسطر) وباللغة العربية وبأسلوب مهني واضح. إن لم يعرف السؤال بالنظام أرشده بلطف.',
    `سؤال من ${user.name} (الدور: ${user.role}${isLoc ? '، محلية ' + (user.locality_id || '') : ''}): ${q}`
  );
  if (llm) return { reply: llm.trim(), source: 'llm' };

  const capabilities = isAdmin
    ? 'يمكنني مساعدتك في: إجمالي النظام وإحصائياته، إنشاء روابط المشاركة، التصدير والنسخ الاحتياطي، المراجعة والموافقات، ومساعدة التدقيق لكل تقرير (زر «مساعدة الذكاء»).'
    : isLoc
      ? 'يمكنني مساعدتك في: إحصائيات محليتك، مراجعة التقارير والموافقة/الرفض، إضافة تقارير جديدة، ومعرفة حالات التقارير.'
      : 'يمكنني مساعدتك في: إضافة تقرير جديد، حالة تقاريرك وإحصائياتها، تصحيح تقرير مرفوض، ومعنى الرقم المرجعي ND-.';

  return {
    reply: `لم أجد إجابة دقيقة لسؤالك. ${capabilities} جرّب صياغة السؤال بوضوح أو اطرحه على مدير النظام.`,
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
