/* =====================================================================
   الإصدار 3.0 — ربط البرنامج بقاعدة البيانات المركزية (Supabase)
   - الدخول عبر Supabase Auth (كلمات المرور مشفرة على الخادم).
   - البيانات تُقرأ من الجداول حسب صلاحيات المستخدم (RLS) وتُحفظ بالفروقات فقط.
   - التحديث الفوري: أي تعديل من مستخدم يظهر عند الجميع دون إعادة تحميل.
   - الأنظمة المدمجة تحفظ بياناتها في الخادم لكل قسم على حدة (جدول app_storage).
   ===================================================================== */
(function () {
  'use strict';
  const CFG = window.DMS_CONFIG || {};
  if (!window.supabase || !CFG.supabaseUrl || !CFG.supabaseAnonKey || /YOUR-/.test(CFG.supabaseUrl)) {
    document.body.innerHTML = '<div dir="rtl" style="font-family:Tahoma,sans-serif;max-width:560px;margin:80px auto;padding:24px;border:1px solid #ddd;border-radius:10px;line-height:1.9"><h2>لم يُضبط الاتصال بقاعدة البيانات</h2><p>عدّل ملف <b>config.js</b> وضع فيه رابط مشروع Supabase والمفتاح العام (anon key)، ثم أعد تحميل الصفحة. التفاصيل في دليل التشغيل (README).</p></div>';
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storage: window.sessionStorage, storageKey: 'dms-auth' },
  });
  window.SB = sb;
  const DOMAIN = CFG.emailDomain || 'dms.local';

  /* ---------- جداول الأعمال ---------- */
  const T = { tasks: 'tasks', kpis: 'kpis', visits: 'visits', clo: 'clo', files: 'files', templates: 'templates',
    initiatives: 'initiatives', events: 'events', goals: 'goals', collegeEvents: 'college_events', notifs: 'notifs', log: 'activity_log' };
  const C_BY_T = Object.fromEntries(Object.entries(T).map(([c, t]) => [t, c]));
  const APPEND_ONLY = new Set(['log', 'notifs']);        // تقليص القوائم محليًا لا يحذف من الخادم
  const clean = (o) => { const c = Object.assign({}, o); delete c._u; return c; };
  const J = (o) => JSON.stringify(clean(o));

  function toRow(C, it, isNew) {
    const r = { id: it.id, data: clean(it) };
    if (C === 'goals') r.dept_id = it.dept || null;
    else if (C === 'notifs') r.to_user = it.to;
    else if (C === 'log') { r.at = it.at || nowISO(); r.user_app_id = ME ? ME.id : null; r.committee_id = it.committee || null; }
    else if (C !== 'collegeEvents') r.committee_id = it.committee || null;
    if (isNew) r.created_by = ME ? ME.id : null;
    return r;
  }
  const fromRow = (r) => Object.assign({}, r.data || {}, { id: r.id });
  const commRow = (c) => { const d = clean(c); ['id', 'dept', 'level', 'type', 'name'].forEach((k) => delete d[k]);
    return { id: c.id, dept_id: c.dept || null, level: c.level || 'dept', type: c.type || c.id, name: c.name, data: d }; };
  const commFrom = (r) => Object.assign({}, r.data || {}, { id: r.id, dept: r.dept_id || '', level: r.level, type: r.type, name: r.name });
  const depRow = (d) => ({ id: d.id, name: d.name, note: d.note || '' });
  const depFrom = (r) => ({ id: r.id, name: r.name, note: r.note || '' });
  const userFrom = (p, mems) => ({
    id: p.app_id, authId: p.id, username: p.username, email: p.email || (p.username + '@' + DOMAIN), name: p.name, title: p.title || '',
    isAdmin: !!p.is_admin, collegeRole: p.college_role || '', headDept: p.head_dept || '', head: !!p.head_dept,
    active: p.active !== false, mustChange: !!p.must_change,
    memberships: Object.fromEntries(mems.filter((m) => m.user_app_id === p.app_id).map((m) => [m.committee_id, m.role])),
  });
  const userSig = (u) => JSON.stringify({ n: u.name, t: u.title || '', m: u.memberships || {} });

  /* ---------- الحالة ---------- */
  let BASE = null;              // آخر نسخة معروفة من الخادم (لحساب الفروقات)
  let RT = null, RT_STATE = 'off', LAST_ERR = '';
  let pushing = false, pushAgain = false, pushTimer = null, refreshTimer = null;
  const UPLOADED = new Set();

  function snapBase() {
    const b = {};
    for (const C in T) b[C] = new Map((DB[C] || []).map((it) => [it.id, J(it)]));
    b.committees = new Map(DB.committees.map((c) => [c.id, JSON.stringify(commRow(c))]));
    b.departments = new Map((DB.departments || []).map((d) => [d.id, JSON.stringify(depRow(d))]));
    b.settings = J(DB.settings || {});
    b.appVersions = new Map(Object.entries(DB.appVersions || {}).map(([k, v]) => [k, J(v)]));
    b.customApps = new Map((DB.customApps || []).map((c) => [c.id, J(c)]));
    b.users = new Map(DB.users.map((u) => [u.id, userSig(u)]));
    return b;
  }

  async function fetchAll(table, opts) {
    let out = [], from = 0; const step = 1000;
    for (;;) {
      let q = sb.from(table).select('*');
      if (opts && opts.order) q = q.order(opts.order, { ascending: false });
      const { data, error } = await q.range(from, from + step - 1);
      if (error) throw error;
      out = out.concat(data || []);
      if (!data || data.length < step || (opts && opts.limit && out.length >= opts.limit)) break;
      from += step;
    }
    return out;
  }

  /* تحميل كل البيانات المسموح بها للمستخدم */
  async function loadAll(authId) {
    setConn('busy');
    const names = ['settings', 'departments', 'committees', 'profiles', 'memberships', 'app_versions', 'custom_apps',
      'tasks', 'kpis', 'visits', 'clo', 'files', 'templates', 'initiatives', 'events', 'goals', 'college_events', 'notifs'];
    const res = await Promise.all(names.map((n) => fetchAll(n)));
    const R = Object.fromEntries(names.map((n, i) => [n, res[i]]));
    const logRows = await fetchAll('activity_log', { order: 'at', limit: 1000 });
    const f = freshDB();
    const sRow = R.settings[0];
    const serverSettingsEmpty = !sRow || !sRow.data || !Object.keys(sRow.data).length;
    DB = f;
    DB.settings = Object.assign(f.settings, (sRow && sRow.data) || {});
    DB.departments = R.departments.map(depFrom);
    DB.committees = R.committees.map(commFrom);
    DB.users = R.profiles.map((p) => userFrom(p, R.memberships));
    for (const C in T) if (C !== 'log') DB[C] = R[T[C]].map(fromRow);
    DB.log = logRows.map(fromRow).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
    DB.appVersions = Object.fromEntries(R.app_versions.map((r) => [r.app_key, r.data || {}]));
    DB.customApps = R.custom_apps.map((r) => Object.assign({}, r.data || {}, { id: r.id }));
    DB.tomb = {};
    const me = DB.users.find((u) => u.authId === authId);
    const admin = !!(me && me.isAdmin);
    // المالك: ما يضيفه الترحيل المحلي (لجان افتراضية، القسم الأساسي...) يُرفع للخادم
    if (admin) { BASE = snapBase(); if (serverSettingsEmpty) BASE.settings = ''; }
    if (!DB.committees.length) DB.committees = JSON.parse(JSON.stringify(DEFAULT_COMMITTEES));
    normalize(DB); ensureV21();
    if (!admin) BASE = snapBase();
    if (ME) ME = user(ME.id) || null;
    setConn('ok');
    return me;
  }

  async function reloadUsers() {
    const [profiles, mems] = await Promise.all([fetchAll('profiles'), fetchAll('memberships')]);
    DB.users = profiles.map((p) => userFrom(p, mems));
    BASE.users = new Map(DB.users.map((u) => [u.id, userSig(u)]));
    if (ME) {
      const m = user(ME.id);
      if (!m || m.active === false) { alert('تم إيقاف حسابك أو حذفه.'); await sb.auth.signOut(); sessionStorage.removeItem('dms-session'); location.reload(); return; }
      ME = m;
    }
  }

  /* ---------- الحفظ بالفروقات ---------- */
  function queuePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushDiff, 600); }
  const isNetErr = (e) => !e || !e.code || /fetch|network|Failed/i.test(e.message || '');

  function revert(C, id, json) {
    const list = DB[C];
    const i = list.findIndex((x) => x.id === id);
    if (json == null) { if (i >= 0) list.splice(i, 1); }
    else { const o = JSON.parse(json); if (i >= 0) list[i] = o; else list.push(o); }
  }

  async function pushColl(C) {
    const base = BASE[C], table = T[C];
    const cur = new Map((DB[C] || []).map((it) => [it.id, it]));
    const ins = [], upd = [], del = [];
    for (const [id, it] of cur) { const j = J(it); if (!base.has(id)) ins.push(it); else if (base.get(id) !== j && C !== 'log') upd.push(it); }
    if (!APPEND_ONLY.has(C)) for (const id of base.keys()) if (!cur.has(id)) del.push(id);
    if (C === 'log' && !ME) return true;
    if (!ins.length && !upd.length && !del.length) return true;
    if (C === 'files') for (const f of ins) await uploadFileBlob(f);
    let ok = true;
    const write = async (rows, isNew) => {
      if (!rows.length) return;
      const { error } = await sb.from(table).upsert(rows.map((it) => toRow(C, it, isNew)));
      if (!error) { rows.forEach((it) => base.set(it.id, J(it))); return; }
      if (isNetErr(error)) { ok = false; LAST_ERR = error.message; return; }
      // خطأ صلاحية: نحاول صفًا صفًا ونتراجع عن المرفوض
      for (const it of rows) {
        const { error: e2 } = await sb.from(table).upsert([toRow(C, it, isNew)]);
        if (!e2) base.set(it.id, J(it));
        else if (isNetErr(e2)) { ok = false; LAST_ERR = e2.message; }
        else { revert(C, it.id, base.has(it.id) ? base.get(it.id) : null); denied(e2); }
      }
    };
    await write(ins, true);
    await write(upd, false);
    if (del.length) {
      const { data, error } = await sb.from(table).delete().in('id', del).select('id');
      if (error) { if (isNetErr(error)) { ok = false; LAST_ERR = error.message; } else { del.forEach((id) => revert(C, id, base.get(id))); denied(error); } }
      else {
        const gone = new Set((data || []).map((r) => r.id));
        for (const id of del) {
          if (gone.has(id)) {
            if (C === 'files') { const old = JSON.parse(base.get(id)); sb.storage.from('files').remove([(old.committee || '_') + '/' + id]).catch(() => {}); }
            base.delete(id);
          } else { revert(C, id, base.get(id)); denied({ message: 'لا تملك صلاحية الحذف' }); }
        }
      }
    }
    return ok;
  }

  async function pushCommittees(phase) {
    const base = BASE.committees, admin = isAdmin();
    const cur = new Map(DB.committees.map((c) => [c.id, c]));
    let ok = true;
    if (phase !== 'del') for (const [id, c] of cur) {
      const j = JSON.stringify(commRow(c));
      if (base.get(id) === j) continue;
      if (!base.has(id) && !admin) continue;
      if (base.has(id) && !admin && !isChair(id)) continue;
      const { error } = await sb.from('committees').upsert([commRow(c)]);
      if (!error) base.set(id, j); else if (isNetErr(error)) { ok = false; LAST_ERR = error.message; } else { denied(error); base.set(id, j); }
    }
    if (admin && phase === 'del') for (const id of [...base.keys()]) if (!cur.has(id)) {
      const { error } = await sb.from('committees').delete().eq('id', id);
      if (!error) base.delete(id); else if (isNetErr(error)) ok = false; else { denied(error); base.delete(id); }
    }
    return ok;
  }

  async function pushSimpleAdmin(key, table, list, toR, pk, sigFn) {
    if (!isAdmin()) return true;
    const base = BASE[key]; let ok = true;
    const cur = new Map(list.map((x) => [x[pk || 'id'], x]));
    for (const [id, x] of cur) {
      const row = toR(x), j = sigFn ? sigFn(x) : key === 'departments' ? JSON.stringify(row) : J(x);
      if (base.get(id) === j) continue;
      const { error } = await sb.from(table).upsert([row]);
      if (!error) base.set(id, j); else if (isNetErr(error)) { ok = false; LAST_ERR = error.message; } else { denied(error); base.set(id, j); }
    }
    for (const id of [...base.keys()]) if (!cur.has(id)) {
      const { error } = await sb.from(table).delete().eq(pk === 'app_key' ? 'app_key' : 'id', id);
      if (!error) base.delete(id); else if (isNetErr(error)) ok = false; else { denied(error); base.delete(id); }
    }
    return ok;
  }

  async function pushAppVersions() {
    if (!isAdmin()) return true;
    for (const [k, av] of Object.entries(DB.appVersions || {})) {
      for (const h of av.history || []) {
        if (h.cloud) continue;
        const t = await IDB.get('appv:' + h.vid).catch(() => null);
        if (!t) continue;
        const { error } = await sb.storage.from('apps').upload(k + '_' + h.vid + '.html', new Blob([t], { type: 'text/html' }), { upsert: true, contentType: 'text/html' });
        if (error) { LAST_ERR = error.message; return false; }
        h.cloud = true;
      }
    }
    const list = Object.entries(DB.appVersions || {}).map(([k, v]) => Object.assign({ app_key: k }, v));
    return pushSimpleAdmin('appVersions', 'app_versions', list, (x) => { const d = clean(x); delete d.app_key; return { app_key: x.app_key, data: d }; }, 'app_key',
      (x) => { const d = clean(x); delete d.app_key; return JSON.stringify(d); });
  }

  async function pushUsers() {
    const base = BASE.users; let ok = true;
    for (const u of DB.users) {
      const sig = userSig(u);
      if (base.get(u.id) === sig) continue;
      const old = base.has(u.id) ? JSON.parse(base.get(u.id)) : { n: u.name, t: u.title, m: {} };
      if ((old.n !== u.name || old.t !== (u.title || '')) && (isAdmin() || u.id === ME.id)) {
        const { error } = await sb.from('profiles').update({ name: u.name, title: u.title || '' }).eq('app_id', u.id);
        if (error && isNetErr(error)) { ok = false; continue; }
      }
      const om = old.m || {}, nm = u.memberships || {};
      for (const cid of new Set([...Object.keys(om), ...Object.keys(nm)])) {
        if (om[cid] === nm[cid]) continue;
        const { error } = nm[cid]
          ? await sb.from('memberships').upsert([{ user_app_id: u.id, committee_id: cid, role: nm[cid] }])
          : await sb.from('memberships').delete().eq('user_app_id', u.id).eq('committee_id', cid);
        if (error) { if (isNetErr(error)) { ok = false; } else { denied(error); if (om[cid]) nm[cid] = om[cid]; else delete nm[cid]; } }
      }
      if (ok) base.set(u.id, userSig(u));
    }
    return ok;
  }

  async function pushDiff() {
    if (!ME || !BASE) return true;
    if (pushing) { pushAgain = true; return true; }
    pushing = true; setConn('busy'); let ok = true;
    try {
      ok = (await pushSimpleAdmin('departments', 'departments', DB.departments || [], depRow)) && ok;
      ok = (await pushCommittees('up')) && ok;
      ok = (await pushUsers()) && ok;
      if (isAdmin()) {
        const sj = J(DB.settings);
        if (BASE.settings !== sj) { const { error } = await sb.from('settings').upsert([{ id: 1, data: clean(DB.settings) }]); if (!error) BASE.settings = sj; else ok = false; }
      }
      ok = (await pushSimpleAdmin('customApps', 'custom_apps', DB.customApps || [], (x) => ({ id: x.id, data: clean(x) }))) && ok;
      ok = (await pushAppVersions()) && ok;
      for (const C of ['goals', 'templates', 'tasks', 'kpis', 'visits', 'clo', 'files', 'initiatives', 'events', 'collegeEvents', 'notifs', 'log'])
        ok = (await pushColl(C)) && ok;
      ok = (await pushCommittees('del')) && ok;   // حذف اللجان بعد حذف قوالبها ومراجعها
    } catch (e) { ok = false; LAST_ERR = e.message || String(e); console.error(e); }
    pushing = false;
    setConn(ok ? 'ok' : 'err');
    if (pushAgain) { pushAgain = false; queuePush(); } else if (!ok) setTimeout(queuePush, 15000);
    return ok;
  }

  let deniedShown = 0;
  function denied(e) {
    console.warn('rejected by server', e);
    if (Date.now() - deniedShown > 3000) { deniedShown = Date.now(); toast('رفض الخادم حفظ تعديل لا تملك صلاحيته، وأُعيدت البيانات كما كانت.'); scheduleRefresh(); }
  }

  /* ---------- التحديث الفوري ---------- */
  const RT_TABLES = [...Object.values(T), 'committees', 'departments', 'profiles', 'memberships', 'settings', 'app_versions', 'custom_apps', 'app_storage'];
  function startRealtime() {
    if (RT) return;
    RT = sb.channel('dms-all');
    RT_TABLES.forEach((t) => RT.on('postgres_changes', { event: '*', schema: 'public', table: t }, (p) => { try { applyRemote(p); } catch (e) { console.error(e); } }));
    RT.subscribe((st) => {
      const was = RT_STATE; RT_STATE = st; setConn(st === 'SUBSCRIBED' ? 'ok' : 'err');
      if (st === 'SUBSCRIBED' && was && was !== 'SUBSCRIBED' && was !== 'off') resync();   // بعد انقطاع: جلب ما فات
    });
  }
  let usersTimer = null;
  function applyRemote(p) {
    if (!BASE || !DB) return;
    const t = p.table, ev = p.eventType, n = p.new || {}, o = p.old || {};
    if (C_BY_T[t]) {
      const C = C_BY_T[t], list = DB[C], id = ev === 'DELETE' ? o.id : n.id;
      if (!id) return;
      const i = list.findIndex((x) => x.id === id);
      if (ev === 'DELETE') { if (i >= 0) list.splice(i, 1); BASE[C].delete(id); }
      else { const it = fromRow(n), j = J(it); if (BASE[C].get(id) === j && i >= 0) return; if (i >= 0) list[i] = it; else list.push(it); BASE[C].set(id, j); }
    } else if (t === 'committees') {
      const id = ev === 'DELETE' ? o.id : n.id, i = DB.committees.findIndex((x) => x.id === id);
      if (ev === 'DELETE') { if (i >= 0) DB.committees.splice(i, 1); BASE.committees.delete(id); }
      else { const c = commFrom(n); if (i >= 0) DB.committees[i] = c; else DB.committees.push(c); BASE.committees.set(id, JSON.stringify(commRow(c))); }
    } else if (t === 'departments') {
      const id = ev === 'DELETE' ? o.id : n.id, i = DB.departments.findIndex((x) => x.id === id);
      if (ev === 'DELETE') { if (i >= 0) DB.departments.splice(i, 1); BASE.departments.delete(id); }
      else { const d = depFrom(n); if (i >= 0) DB.departments[i] = d; else DB.departments.push(d); BASE.departments.set(id, JSON.stringify(depRow(d))); }
    } else if (t === 'settings') {
      if (ev !== 'DELETE' && n.data) { Object.assign(DB.settings, n.data); BASE.settings = J(DB.settings); }
    } else if (t === 'app_versions') {
      const k = ev === 'DELETE' ? o.app_key : n.app_key;
      if (ev === 'DELETE') { delete DB.appVersions[k]; BASE.appVersions.delete(k); }
      else { DB.appVersions[k] = n.data || {}; BASE.appVersions.set(k, J(DB.appVersions[k])); }
    } else if (t === 'custom_apps') {
      const id = ev === 'DELETE' ? o.id : n.id, i = DB.customApps.findIndex((x) => x.id === id);
      if (ev === 'DELETE') { if (i >= 0) DB.customApps.splice(i, 1); BASE.customApps.delete(id); }
      else { const c = Object.assign({}, n.data || {}, { id }); if (i >= 0) DB.customApps[i] = c; else DB.customApps.push(c); BASE.customApps.set(id, J(c)); }
    } else if (t === 'profiles' || t === 'memberships') {
      clearTimeout(usersTimer); usersTimer = setTimeout(() => reloadUsers().then(scheduleRefresh), 400); return;
    } else if (t === 'app_storage') { onRemoteAppStorage(p); return; }
    scheduleRefresh();
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (!ME) return; try { updateBell(); if (VIEW.page !== 'settings') softRefresh(); } catch (e) { console.error(e); } }, 350);
    /* صفحات الإعدادات لا تُعاد رسمها تلقائيًا حتى لا تضيع معاينة الاستيراد أو سجل الاستعادة أو نموذج قيد التعبئة */
  }
  async function resync() {
    if (!ME) return;
    try { await pushDiff(); const keepId = ME.id; await loadAll(ME.authId); ME = user(keepId) || ME; scheduleRefresh(); } catch (e) { setConn('err'); }
  }
  window.addEventListener('online', () => { queuePush(); resync(); });

  /* ---------- مؤشر الاتصال ---------- */
  function setConn(state) {
    const el = $('#syncLbl'); if (!el) return;
    const m = { ok: ['✓ متصل', 'good'], busy: ['جارٍ الحفظ…', 'muted'], err: ['⚠ غير متصل — ستُحفظ التعديلات عند عودة الاتصال', 'bad'] }[state] || ['', ''];
    el.textContent = ME ? m[0] : ''; el.className = 'small ' + m[1]; el.title = state === 'err' ? LAST_ERR : '';
  }

  /* ---------- استبدال دوال التخزين والمزامنة القديمة ---------- */
  save = function () {
    ensureDepts(DB);
    if (DB.log.length > 1000) DB.log = DB.log.slice(-1000);
    if (DB.notifs && DB.notifs.length > 500) DB.notifs = DB.notifs.slice(-500);
    queuePush();
  };
  syncNow = async function () { return pushDiff(); };
  scheduleSync = function () { queuePush(); };
  setSync = function (s) { setConn(s === 'off' ? 'ok' : s); };
  autoSnapshot = async function () {};
  listSnapshots = async function () { return []; };

  /* ---------- الدخول والخروج ---------- */
  const loginErr = (s) => s === 'owner' ? 'هذا الحساب ليس حساب المالك.' : s === 'head' ? 'هذا الحساب لا يملك صلاحية رئيس قسم.'
    : s === 'college' ? 'هذا الحساب ليس حساب العميد أو أحد الوكلاء.' : 'هذا الحساب ليس عضوًا في ' + comm(s).name + '. تواصل مع المالك لإضافتك.';

  doLogin = async function (e) {
    e.preventDefault();
    const un = $('#lgUser').value.trim().toLowerCase(), pw = $('#lgPass').value, s = LG_SCOPE;
    if (!s) return;
    $('#lgErr').textContent = 'جارٍ التحقق…';
    const email = un.includes('@') ? un : un + '@' + DOMAIN;
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
    if (error) {
      $('#lgErr').textContent = /invalid/i.test(error.message) ? 'اسم المستخدم أو كلمة المرور غير صحيحة.'
        : /banned/i.test(error.message) ? 'الحساب موقوف. تواصل مع المالك.'
        : /rate|many/i.test(error.message) ? 'محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.' : 'تعذر الدخول: ' + error.message;
      return;
    }
    let u;
    try { u = await loadAll(data.user.id); } catch (err) { $('#lgErr').textContent = 'تعذر تحميل البيانات: ' + (err.message || err); await sb.auth.signOut(); return; }
    if (!u || u.active === false) { await sb.auth.signOut(); $('#lgErr').textContent = 'الحساب غير مفعّل في النظام. تواصل مع المالك.'; return; }
    if (!scopeAllowed(u, s)) { await sb.auth.signOut(); $('#lgErr').textContent = loginErr(s); return; }
    ME = u; SCOPE = s;
    localStorage.setItem('dms-last-user', u.username);
    sessionStorage.setItem('dms-session', JSON.stringify({ u: u.id, scope: s }));
    startRealtime();
    audit('دخول', scopeName(s), '', DB.committees.some((c) => c.id === s) ? s : ''); save();
    $('#lgPass').value = ''; $('#lgErr').textContent = ''; closeLgPanel(); enter();
  };

  logout = async function () {
    try { audit('خروج', 'النظام', ''); save(); await pushDiff(); } catch (e) {}
    await sb.auth.signOut(); sessionStorage.removeItem('dms-session'); location.reload();
  };

  changePassword = function (forced) {
    modal(forced ? 'غيّر كلمة المرور قبل المتابعة' : 'تغيير كلمة المرور',
      `<div class="formgrid">${forced ? '<p class="small muted full" style="margin:0">كلمة المرور الحالية مؤقتة. اختر كلمة مرور خاصة بك (8 أحرف على الأقل).</p>' : '<label class="f full">كلمة المرور الحالية<input id="pw0" type="password" autocomplete="current-password"></label>'}<label class="f">كلمة المرور الجديدة<input id="pw1" type="password" autocomplete="new-password"></label><label class="f">تأكيدها<input id="pw2" type="password" autocomplete="new-password"></label><div class="err full" id="pwErr"></div></div>`,
      `<button class="btn primary" onclick="doChangePass(${!!forced})">حفظ كلمة المرور</button>${forced ? '' : '<button class="btn" onclick="closeModal()">إلغاء</button>'}`, false, !!forced);
  };
  doChangePass = async function (forced) {
    const p1 = $('#pw1').value, p2 = $('#pw2').value;
    if (p1.length < 8) { $('#pwErr').textContent = 'استخدم 8 أحرف على الأقل.'; return; }
    if (p1 !== p2) { $('#pwErr').textContent = 'التأكيد لا يطابق كلمة المرور.'; return; }
    $('#pwErr').textContent = 'جارٍ الحفظ…';
    if (!forced) {
      const { error } = await sb.auth.signInWithPassword({ email: ME.email, password: $('#pw0').value });
      if (error) { $('#pwErr').textContent = 'كلمة المرور الحالية غير صحيحة.'; return; }
    }
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) { $('#pwErr').textContent = 'تعذر الحفظ: ' + error.message; return; }
    await sb.from('profiles').update({ must_change: false }).eq('id', ME.authId);
    ME.mustChange = false; audit('تغيير كلمة المرور', 'مستخدم', ME.username); save();
    closeModal(true); toast('تم حفظ كلمة المرور');
  };

  /* ---------- إدارة المستخدمين عبر دالة الخادم ---------- */
  async function fnErr(error, data) {
    if (data && data.error) return data.error;
    try { if (error && error.context && error.context.json) { const j = await error.context.json(); if (j && j.error) return j.error; } } catch (e) {}
    return (error && error.message) || 'تعذر الحفظ';
  }
  saveUser = async function (id) {
    const name = val('uN'), un = val('uU').toLowerCase(), pw = $('#uP').value;
    if (!name || !un) { $('#uErr').textContent = 'الاسم واسم المستخدم مطلوبان.'; return; }
    if (!/^[a-z0-9._-]{3,}$/.test(un)) { $('#uErr').textContent = 'اسم المستخدم بالأحرف الإنجليزية والأرقام، 3 أحرف على الأقل.'; return; }
    if (!id && DB.users.some((x) => x.username.toLowerCase() === un)) { $('#uErr').textContent = 'اسم المستخدم مستخدم من قبل.'; return; }
    if ((!id || pw) && pw.length < 8) { $('#uErr').textContent = 'كلمة المرور المؤقتة 8 أحرف على الأقل.'; return; }
    const u = id ? user(id) : null;
    if (u && !canManageUser(u)) { $('#uErr').textContent = 'لا تملك صلاحية تعديل هذا الحساب.'; return; }
    const mems = {};
    DB.committees.forEach((c) => { const el = document.getElementById('um-' + c.id); if (el) mems[c.id] = el.value || ''; });
    const body = { action: id ? 'update' : 'create', appId: id || undefined, username: un, name, title: val('uTi'), password: pw || undefined, memberships: mems };
    if (isAdmin()) {
      if ($('#uA') && !$('#uA').disabled) body.isAdmin = $('#uA').checked;
      if ($('#uHD')) body.headDept = $('#uHD').value;
      if ($('#uCR')) body.collegeRole = $('#uCR').value;
    }
    if ($('#uAc') && !$('#uAc').disabled) body.active = $('#uAc').checked;
    $('#uErr').textContent = 'جارٍ الحفظ…';
    const { data, error } = await sb.functions.invoke(CFG.usersFunction || 'admin-users', { body });
    if (error || (data && data.error)) { $('#uErr').textContent = await fnErr(error, data); return; }
    audit(id ? 'عدّل مستخدمًا' : 'أنشأ مستخدمًا', name, un); save();
    await reloadUsers(); closeModal(); refresh(); toast('تم حفظ المستخدم');
  };

  /* ---------- المرفقات عبر التخزين المركزي ---------- */
  async function uploadFileBlob(f) {
    if (UPLOADED.has(f.id)) return;
    const b = await IDB.get('file:' + f.id).catch(() => null);
    if (!b) return;
    const { error } = await sb.storage.from('files').upload((f.committee || '_') + '/' + f.id, b, { upsert: true, contentType: f.type || 'application/octet-stream' });
    if (!error) UPLOADED.add(f.id); else console.warn('upload failed', error);
  }
  pushFile = async function (id) { const f = DB.files.find((x) => x.id === id); if (f) await uploadFileBlob(f); };
  downloadFile = async function (id) {
    const f = DB.files.find((x) => x.id === id); if (!f) return;
    let b = await IDB.get('file:' + id).catch(() => null);
    if (!b) {
      const { data, error } = await sb.storage.from('files').download((f.committee || '_') + '/' + id);
      if (error || !data) { alert('تعذر تنزيل الملف: ' + ((error && error.message) || 'غير موجود')); return; }
      b = data; IDB.put('file:' + id, b).catch(() => {});
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = f.name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  /* ---------- ملفات الأنظمة ---------- */
  const APP_CACHE = {};
  builtinText = async function (a) {
    if (APP_CACHE[a]) return APP_CACHE[a];
    try { const r = await fetch('apps/' + encodeURIComponent(a) + '.html', { cache: 'no-cache' }); if (!r.ok) return null; return (APP_CACHE[a] = await r.text()); }
    catch (e) { return null; }
  };
  versionText = async function (a, vid) {
    let t = await IDB.get('appv:' + vid).catch(() => null);
    if (!t) {
      const { data } = await sb.storage.from('apps').download(a + '_' + vid + '.html');
      if (data) { t = await data.text(); IDB.put('appv:' + vid, t).catch(() => {}); }
    }
    return t;
  };

  /* ---------- الأنظمة المدمجة: تخزينها في الخادم لكل قسم ---------- */
  const APP_KEYS = { training: /^tms-/, exams: /^(exam|ota_)/, readiness: /^(academia:|readiness:)/, surveys: /^srv_/ };
  const LOCAL_ONLY = { training: /^tms-(session|local|local-role|fonts|nodigit|track)$/, exams: /^(ota_|examAtt_recSection)/, readiness: /(attempt|envelope)/ };
  const isLocalKey = (a, k) => /session|token/i.test(k) || !!(LOCAL_ONLY[a] && LOCAL_ONLY[a].test(k));
  window.DMS_APPSTORE = {};
  function appScope(a) {
    const A = allApps()[a]; const c = A && comm(A.committee);
    if (c && c.level === 'college') return 'college';
    return (SCOPE && deptOf(SCOPE)) || curDept() || 'college';
  }
  async function preloadAppStore(a) {
    const scope = appScope(a);
    const { data, error } = await sb.from('app_storage').select('key,value,version').eq('app_key', a).eq('scope', scope);
    if (error) throw error;
    const map = new Map(), ver = new Map();
    (data || []).forEach((r) => { map.set(r.key, r.value); ver.set(r.key, r.version); });
    const lsp = 'dmsapp:' + a + '|' + scope + ':';
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(lsp)) map.set(k.slice(lsp.length), localStorage.getItem(k)); }
    const S = { app: a, scope, map, ver, pending: new Map(), timer: null, conflicts: new Map(), remoteChanged: false,
      put(k, v) { if (isLocalKey(a, k)) { try { localStorage.setItem(lsp + k, v); } catch (e) {} return; } S.pending.set(k, v); sched(); },
      del(k) { if (isLocalKey(a, k)) { localStorage.removeItem(lsp + k); return; } S.pending.set(k, null); sched(); } };
    function sched() { clearTimeout(S.timer); S.timer = setTimeout(() => flushApp(S), 1500); }
    window.DMS_APPSTORE[a] = S;
    return S;
  }
  async function flushApp(S, force) {
    for (const [k, v] of [...S.pending]) {
      S.pending.delete(k);
      if (v === null) { const { error } = await sb.rpc('app_storage_del', { p_app: S.app, p_scope: S.scope, p_key: k }); if (error) { S.pending.set(k, v); break; } S.ver.delete(k); continue; }
      const { data, error } = await sb.rpc('app_storage_put', { p_app: S.app, p_scope: S.scope, p_key: k, p_value: v, p_expected: force ? null : (S.ver.has(k) ? S.ver.get(k) : null) });
      if (error) { S.pending.set(k, v); LAST_ERR = error.message; setConn('err'); setTimeout(() => flushApp(S), 10000); break; }
      if (data && data.ok) S.ver.set(k, data.version);
      else { S.conflicts.set(k, v); renderToolNotice(S.app); }
    }
  }
  function onRemoteAppStorage(p) {
    const n = p.new || {}, o = p.old || {};
    const a = n.app_key || o.app_key, S = window.DMS_APPSTORE[a];
    if (!S || (n.scope && n.scope !== S.scope)) return;
    if (p.eventType !== 'DELETE' && ME && n.updated_by === ME.id) return;
    if (p.eventType !== 'DELETE' && S.ver.get(n.key) >= n.version) return;
    S.remoteChanged = true; renderToolNotice(a);
  }
  window.dmsAppResolve = async function (a, mine) {
    const S = window.DMS_APPSTORE[a]; if (!S) return;
    if (mine) { S.conflicts.forEach((v, k) => S.pending.set(k, v)); S.conflicts.clear(); await flushApp(S, true); toast('اعتُمدت نسختك.'); renderToolNotice(a); }
    else { S.conflicts.clear(); S.remoteChanged = false; reloadTool(a); }
  };
  function renderToolNotice(a) {
    const S = window.DMS_APPSTORE[a], bar = $('#toolBar'); if (!bar || !S) return;
    let el = document.getElementById('appNotice');
    if (!el) { el = document.createElement('div'); el.id = 'appNotice'; el.style.cssText = 'flex-basis:100%;font-size:13px'; bar.appendChild(el); }
    el.innerHTML = S.conflicts.size
      ? `<span class="bad">عدّل مستخدم آخر بيانات هذا النظام أثناء عملك، ولم تُحفظ آخر تعديلاتك.</span> <button class="btn sm" onclick="dmsAppResolve('${a}',false)">تحميل آخر نسخة (تُلغى تعديلاتي)</button> <button class="btn sm danger" onclick="dmsAppResolve('${a}',true)">اعتماد نسختي</button>`
      : S.remoteChanged ? `<span style="color:var(--wait)">حدّث مستخدم آخر بيانات هذا النظام.</span> <button class="btn sm" onclick="dmsAppResolve('${a}',false)">إعادة التحميل لرؤيتها</button>` : '';
  }
  function injectShim(html, a) {
    const shim = `<script>(function(){var P=window.parent,S=P&&P.DMS_APPSTORE&&P.DMS_APPSTORE[${JSON.stringify(a)}];if(!S)return;var m=S.map;
var st={getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){k=String(k);v=String(v);if(m.get(k)===v)return;m.set(k,v);S.put(k,v)},
removeItem:function(k){k=String(k);if(!m.has(k))return;m.delete(k);S.del(k)},clear:function(){Array.from(m.keys()).forEach(function(k){st.removeItem(k)})},
key:function(i){return Array.from(m.keys())[i]||null}};Object.defineProperty(st,'length',{get:function(){return m.size},configurable:true});
var px=new Proxy(st,{get:function(t,p){if(typeof p==='symbol'||p in t)return t[p];return t.getItem(p)},set:function(t,p,v){t.setItem(p,v);return true},
deleteProperty:function(t,p){t.removeItem(p);return true},has:function(t,p){return p in t||m.has(String(p))},ownKeys:function(){return Array.from(m.keys())},
getOwnPropertyDescriptor:function(t,p){return m.has(String(p))?{value:m.get(String(p)),enumerable:true,configurable:true,writable:true}:undefined}});
try{Object.defineProperty(window,'localStorage',{configurable:true,get:function(){return px}})}catch(e){P.console.warn('storage shim',e)}})();<\/script>`;
    return /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, (m) => m + shim) : shim + html;
  }
  const _rawAppText = appHtmlText;
  appHtmlText = async function (a) {
    const t = await _rawAppText(a);
    try { await preloadAppStore(a); } catch (e) {
      return '<p dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center">تعذر تحميل بيانات هذا النظام من الخادم: ' + esc(e.message || e) + '</p>';
    }
    return injectShim(t, a);
  };
  appHtmlBlob = async function (a) { return new Blob([await _rawAppText(a)], { type: 'text/html;charset=utf-8' }); };
  const _openTool = openTool;
  openTool = async function (a) {
    const meta = ((DB.settings.appMeta || {})[a]) || {};
    if (meta.disabled) { toast('هذا النظام معطّل من «الأنظمة والتحديثات».'); go('home'); return; }
    const sc = appScope(a);
    if (FRAMES[a] && FRAMES[a].dataset.scope !== sc) { FRAMES[a].remove(); delete FRAMES[a]; }
    await _openTool(a);
    if (FRAMES[a]) FRAMES[a].dataset.scope = sc;
    const bar = $('#toolBar');
    /* اسم اللجنة في شريط النظام يطابق القسم الذي تُعرض بياناته */
    try {
      const c0 = comm(allApps()[a].committee);
      const alt = (c0 && c0.dept && sc !== 'college' && c0.dept !== sc) ? DB.committees.find((x) => (x.type || x.id) === (c0.type || c0.id) && x.dept === sc) : null;
      if (bar && alt) { const w = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.nodeValue.includes(c0.name)) n.nodeValue = n.nodeValue.split(c0.name).join(alt.name); }
    } catch (e) {}
    if (bar) { const o1 = document.getElementById('appScopeLbl'); if (o1) o1.remove(); const o2 = document.getElementById('appImpBtn'); if (o2) o2.remove(); }
    if (bar) {
      const free = sc !== 'college' && (!SCOPE || ['owner', 'head', 'college'].includes(SCOPE)) && (isAdmin() || (ME && ME.collegeRole)) && (DB.departments || []).length > 1;
      let lbl;
      if (free) {
        /* المالك والعميد والوكلاء يختارون القسم الذي يفتحون بياناته */
        lbl = document.createElement('label'); lbl.id = 'appScopeLbl'; lbl.className = 'pill st-prog'; lbl.style.cssText = 'display:inline-flex;gap:6px;align-items:center';
        lbl.innerHTML = 'بيانات: <select style="padding:2px 6px;font:inherit;border-radius:6px">' + DB.departments.map((d) => `<option value="${esc(d.id)}"${d.id === sc ? ' selected' : ''}>${esc(d.name)}</option>`).join('') + '</select>';
        lbl.querySelector('select').onchange = (e) => { SEL_DEPT = e.target.value; if (FRAMES[a]) { FRAMES[a].remove(); delete FRAMES[a]; } go('tool', { app: a }); };
      } else {
        lbl = document.createElement('span'); lbl.id = 'appScopeLbl'; lbl.className = 'pill st-prog';
        lbl.textContent = 'بيانات: ' + (sc === 'college' ? 'مستوى الكلية' : deptName(sc));
      }
      bar.insertBefore(lbl, bar.children[1] || null);
      if (isAdmin() || isChair(allApps()[a].committee)) {
        const b = document.createElement('label'); b.id = 'appImpBtn'; b.className = 'btn sm'; b.textContent = 'استيراد بيانات من النسخة السابقة';
        b.innerHTML += `<input type="file" accept=".json" class="hidden" onchange="dmsImportAppData('${a}',this.files[0])">`; bar.appendChild(b);
      }
    }
    renderToolNotice(a);
  };
  /* استيراد بيانات نظام من ملف أنشأته صفحة export-local.html على الجهاز القديم */
  window.dmsImportAppData = async function (a, f) {
    if (!f) return;
    let d; try { d = JSON.parse(await f.text()); } catch (e) { alert('ملف غير صالح.'); return; }
    const src = d.localStorage || d;
    const re = APP_KEYS[a] || /.^/;
    const keys = Object.keys(src).filter((k) => re.test(k) && !isLocalKey(a, k) && typeof src[k] === 'string');
    if (!keys.length) { alert('لا توجد بيانات لهذا النظام في الملف.'); return; }
    const sc = appScope(a);
    if (!confirm('سيُرفع ' + keys.length + ' عنصر ليصبح بيانات هذا النظام في ' + (sc === 'college' ? 'مستوى الكلية' : deptName(sc)) + '، ويستبدل البيانات الحالية فيه. متابعة؟')) return;
    for (const k of keys) {
      const { error } = await sb.rpc('app_storage_put', { p_app: a, p_scope: sc, p_key: k, p_value: src[k], p_expected: null });
      if (error) { alert('تعذر الرفع: ' + error.message); return; }
    }
    audit('استيراد بيانات نظام', allApps()[a].name, keys.length + ' عنصر'); save();
    toast('تم الاستيراد'); reloadTool(a);
  };

  /* ---------- النسخ الاحتياطي والاستعادة ---------- */
  restore = async function (f) {
    if (!isAdmin()) { alert('الاستعادة من صلاحية المالك.'); return; }
    if (!f) return; let d;
    try { d = JSON.parse(await f.text()); } catch (e) { alert('ملف غير صالح.'); return; }
    if (!d.db || !d.db.users) { alert('هذا ليس ملف نسخة احتياطية للمنصة.'); return; }
    if (!confirm('ستُستبدل بيانات الأعمال في قاعدة البيانات المركزية (عند كل المستخدمين) بالنسخة (' + fmtDT(d.at) + '). الحسابات لا تتغير. متابعة؟')) return;
    for (const [id, url] of Object.entries(d.files || {})) { const b = await (await fetch(url)).blob(); await IDB.put('file:' + id, b); }
    for (const [vid, t] of Object.entries(d.apps || {})) await IDB.put('appv:' + vid, t);
    const users = DB.users;
    DB = normalize(d.db); ensureV21(); DB.users = users; ME = user(ME.id);
    setConn('busy'); const ok = await pushDiff();
    alert(ok ? 'تمت الاستعادة.' : 'استُعيد جزء من البيانات وتعذر رفع الباقي: ' + LAST_ERR); location.reload();
  };
  wipe = async function () {
    if (!confirm('مسح الملفات المؤقتة المحفوظة على هذا الجهاز وتسجيل الخروج؟ لا تتأثر بيانات القسم في الخادم.')) return;
    for (const k of await IDB.keys()) await IDB.del(k);
    Object.keys(localStorage).filter((k) => /^(dms|dmsapp)/.test(k)).forEach((k) => localStorage.removeItem(k));
    await sb.auth.signOut(); sessionStorage.clear(); location.reload();
  };

  /* ---------- صفحة «المزامنة» في الإعدادات ---------- */
  setSyncTab = function () {
    return `<div class="panel"><h3>قاعدة البيانات المركزية<span class="sp"></span><span class="pill ${RT_STATE === 'SUBSCRIBED' ? 'st-done' : 'st-late'}">${RT_STATE === 'SUBSCRIBED' ? 'متصل – تحديث فوري' : 'غير متصل'}</span></h3><div class="body">
      <p class="small">البرنامج يعمل على قاعدة بيانات Supabase مركزية. كل مستخدم يدخل بحسابه من أي جهاز، ويرى البيانات المصرح له بها فقط، وتظهر التعديلات عند الجميع فورًا.</p>
      <table class="t"><tr><td>رابط المشروع</td><td dir="ltr">${esc(CFG.supabaseUrl)}</td></tr><tr><td>نطاق أسماء الدخول</td><td dir="ltr">@${esc(DOMAIN)}</td></tr><tr><td>آخر خطأ</td><td class="small">${esc(LAST_ERR || '—')}</td></tr></table>
      <div style="margin-top:10px;display:flex;gap:8px"><button class="btn primary" onclick="dmsResync()">إعادة المزامنة الآن</button></div>
      <p class="small muted" style="margin-top:10px">إضافة المستخدمين من «المستخدمون والصلاحيات». النسخ الاحتياطي الدوري لقاعدة البيانات من لوحة Supabase، ويمكن تنزيل نسخة كاملة من «النسخ الاحتياطي».</p></div></div>`;
  };
  window.dmsResync = async function () { await resync(); toast('تمت المزامنة'); refresh(); };

  /* ---------- النسخة الاحتياطية الشاملة لقاعدة البيانات ---------- */
  const BACKUP_TABLES = ['settings', 'departments', 'committees', 'profiles', 'memberships', 'app_versions', 'custom_apps',
    'tasks', 'kpis', 'visits', 'clo', 'files', 'templates', 'initiatives', 'events', 'goals', 'college_events', 'notifs',
    'activity_log', 'app_storage', 'online_exams', 'online_submissions'];
  function daysSince(iso) { return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null; }
  window.dmsFullBackup = async function (btn) {
    if (!isAdmin()) { alert('النسخة الشاملة من صلاحية المالك.'); return; }
    const withFiles = !!(document.getElementById('fbFiles') || {}).checked;
    const st = document.getElementById('fbStatus');
    const say = (t) => { if (st) st.textContent = t; };
    if (btn) btn.disabled = true;
    try {
      const out = { kind: 'dms-full-backup', v: 1, at: new Date().toISOString(), project: CFG.supabaseUrl, tables: {}, storage: {} };
      for (const t of BACKUP_TABLES) {
        say('جارٍ نسخ: ' + t + '…');
        try { out.tables[t] = await fetchAll(t); } catch (e) { out.tables[t] = { error: e.message || String(e) }; }
      }
      if (withFiles) {
        const files = Array.isArray(out.tables.files) ? out.tables.files : [];
        let n = 0;
        for (const f of files) {
          const d = f.data || {}, path = (f.committee_id || '_') + '/' + f.id;
          say('جارٍ نسخ المرفقات: ' + (++n) + ' من ' + files.length);
          const { data } = await sb.storage.from('files').download(path);
          if (data) out.storage['files/' + path] = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(data); });
        }
      }
      const counts = Object.entries(out.tables).map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.length : 'خطأ')).join('، ');
      const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'نسخة_شاملة_' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      DB.settings.lastFullBackup = out.at; save();
      audit('نسخة احتياطية شاملة', 'قاعدة البيانات', Math.round(blob.size / 1024) + ' ك.ب');
      say('تم التنزيل (' + Math.round(blob.size / 1024) + ' ك.ب). ' + counts);
    } catch (e) { say('تعذر إكمال النسخة: ' + (e.message || e)); }
    if (btn) btn.disabled = false;
  };
  function fullBackupCard() {
    const d = daysSince(DB.settings.lastFullBackup);
    return `<div class="panel"><h3>النسخة الاحتياطية الشاملة لقاعدة البيانات</h3><div class="body">
      <p class="small">تنزّل ملفًا واحدًا فيه <b>كل</b> بيانات الموقع من قاعدة البيانات المركزية: الأقسام واللجان والمستخدمين وصلاحياتهم، والمهام والمؤشرات والملفات، وبيانات الأنظمة المدمجة لكل قسم، والاختبارات الإلكترونية ونتائج الطلاب، وسجل الحركات.
      الخطة المجانية في Supabase لا تأخذ نسخًا تلقائية، فهذه النسخة هي ضمانك عند أي طارئ. احفظها خارج جهازك (بريدك أو Google Drive)، مرة كل أسبوع على الأقل، وقبل أي تحديث كبير.</p>
      <p class="small ${d === null || d > 7 ? 'bad' : 'good'}"><b>آخر نسخة شاملة: ${d === null ? 'لم تؤخذ بعد' : d === 0 ? 'اليوم' : 'منذ ' + d + ' يوم'}</b></p>
      <label class="check"><input type="checkbox" id="fbFiles" checked> تضمين المرفقات (الملفات المرفوعة في المهام والوثائق)</label>
      <div style="margin-top:10px"><button class="btn primary" onclick="dmsFullBackup(this)">تنزيل نسخة شاملة الآن</button></div>
      <p class="small muted" id="fbStatus" style="margin-top:8px"></p></div></div>`;
  }
  /* ---------- الاستعادة من النسخة الشاملة ---------- */
  const PK = { memberships: 'user_app_id,committee_id', app_storage: 'app_key,scope,key', app_versions: 'app_key', settings: 'id' };
  const GEN_COLS = { tasks: ['title', 'status', 'assignee', 'start_date', 'end_date', 'term'] };
  const RGROUPS = [
    { k: 'org', label: 'الأقسام واللجان والإعدادات وإصدارات الأنظمة', tables: ['departments', 'committees', 'settings', 'app_versions', 'custom_apps'] },
    { k: 'users', label: 'المستخدمون وعضوياتهم', hint: 'يُنشأ المستخدم المفقود بكلمة مرور مؤقتة جديدة، وتُنزَّل لك قائمة بها', tables: ['profiles', 'memberships'] },
    { k: 'work', label: 'أعمال اللجان: المهام والمؤشرات والزيارات والقياس والمبادرات والقوالب والتقويم والخطط والمرفقات', tables: ['tasks', 'kpis', 'visits', 'clo', 'initiatives', 'templates', 'events', 'goals', 'college_events', 'files'] },
    { k: 'apps', label: 'بيانات الأنظمة الأربعة (التدريب، الجاهزية، الاختبارات، الاستطلاعات)', tables: ['app_storage'] },
    { k: 'online', label: 'الاختبارات الإلكترونية ونتائج الطلاب', tables: ['online_exams', 'online_submissions'] },
    { k: 'logs', label: 'سجل الحركات والإشعارات', tables: ['activity_log', 'notifs'] },
  ];
  let RB = null;   // النسخة المحمّلة
  const pkOf = (t, r) => (PK[t] || 'id').split(',').map((c) => String(r[c])).join('|');
  async function fetchKeys(table) {
    const cols = PK[table] || 'id'; let out = [], from = 0;
    for (;;) {
      const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
      if (error) throw error;
      out = out.concat(data || []); if (!data || data.length < 1000) break; from += 1000;
    }
    return new Set(out.map((r) => pkOf(table, r)));
  }
  function deptFilter(b, d) {
    if (!d) return null;
    const comms = new Set((b.tables.committees || []).filter((c) => c.dept_id === d).map((c) => c.id));
    const users = new Set([...(b.tables.memberships || []).filter((m) => comms.has(m.committee_id)).map((m) => m.user_app_id),
      ...(b.tables.profiles || []).filter((p) => p.head_dept === d).map((p) => p.app_id)]);
    return function (t, r) {
      switch (t) {
        case 'departments': return r.id === d;
        case 'committees': return r.dept_id === d;
        case 'goals': return r.dept_id === d;
        case 'app_storage': case 'online_exams': case 'online_submissions': return r.scope === d;
        case 'profiles': return users.has(r.app_id);
        case 'settings': case 'app_versions': case 'custom_apps': case 'college_events': case 'notifs': return false;
        default: return !!r.committee_id && comms.has(r.committee_id);
      }
    };
  }
  function tmpPass() { const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; let p = ''; for (let i = 0; i < 10; i++) p += A[Math.floor(Math.random() * A.length)]; return p + '7'; }
  function rlog(t, cls) { const el = document.getElementById('rsLog'); if (!el) return; const d = document.createElement('div'); d.textContent = t; if (cls) d.className = cls; el.appendChild(d); el.scrollTop = el.scrollHeight; }
  async function writeTable(t, rows, mode) {
    rows = rows.map((r) => { const c = Object.assign({}, r); (GEN_COLS[t] || []).forEach((k) => delete c[k]); return c; });
    let existing; try { existing = await fetchKeys(t); } catch (e) { rlog('✗ ' + t + ': ' + (e.message || e), 'bad'); return { fail: rows.length }; }
    const fresh = rows.filter((r) => !existing.has(pkOf(t, r)));
    const send = mode === 'overwrite' ? rows : fresh;
    let ok = 0, fail = 0, err = '';
    for (let i = 0; i < send.length; i += 200) {
      const chunk = send.slice(i, i + 200);
      const { error } = await sb.from(t).upsert(chunk, { onConflict: PK[t] || 'id' });
      if (!error) { ok += chunk.length; continue; }
      for (const r of chunk) { const { error: e2 } = await sb.from(t).upsert([r], { onConflict: PK[t] || 'id' }); if (e2) { fail++; err = e2.message; } else ok++; }
    }
    const added = Math.min(fresh.length, ok), updated = mode === 'overwrite' ? Math.max(0, ok - fresh.length) : 0;
    rlog((fail ? '⚠ ' : '✓ ') + t + ': أُضيف ' + added + (mode === 'overwrite' ? '، حُدِّث ' + updated : '، موجود مسبقًا ' + (rows.length - fresh.length)) + (fail ? '، تعذّر ' + fail + ' (' + err + ')' : ''), fail ? 'bad' : '');
    return { added, updated, fail };
  }
  async function restoreUsers(b, filter, mode, creds) {
    const prof = (b.tables.profiles || []).filter((p) => !filter || filter('profiles', p));
    const { data: cur } = await sb.from('profiles').select('app_id,username');
    const have = new Set((cur || []).map((p) => p.username.toLowerCase())), haveId = new Set((cur || []).map((p) => p.app_id));
    let made = 0, skip = 0, fail = 0;
    for (const p of prof) {
      if (have.has(String(p.username).toLowerCase()) || haveId.has(p.app_id)) { skip++; continue; }
      const pw = tmpPass();
      const { data, error } = await sb.functions.invoke(CFG.usersFunction || 'admin-users', { body: {
        action: 'create', appId: p.app_id, username: p.username, email: p.email, name: p.name, title: p.title || '', password: pw,
        isAdmin: !!p.is_admin, collegeRole: p.college_role || '', headDept: p.head_dept || '', memberships: {} } });
      if (error || (data && data.error)) { fail++; rlog('✗ المستخدم ' + p.username + ': ' + ((data && data.error) || (error && error.message)), 'bad'); continue; }
      if (p.active === false) await sb.functions.invoke(CFG.usersFunction || 'admin-users', { body: { action: 'update', appId: p.app_id, active: false } });
      creds.push([p.name, p.email && !/@dms\.local$/i.test(p.email) ? p.email : p.username, pw]); made++;
    }
    rlog('✓ المستخدمون: أُنشئ ' + made + '، موجود مسبقًا ' + skip + (fail ? '، تعذّر ' + fail : ''), fail ? 'bad' : '');
    const { data: now } = await sb.from('profiles').select('app_id');
    const ids = new Set((now || []).map((p) => p.app_id));
    const { data: cm } = await sb.from('committees').select('id');
    const cids = new Set((cm || []).map((c) => c.id));
    const mems = (b.tables.memberships || []).filter((m) => (!filter || filter('memberships', m)) && ids.has(m.user_app_id) && cids.has(m.committee_id));
    await writeTable('memberships', mems, mode);
  }
  async function restoreFiles(b, filter, comms) {
    const keys = Object.keys(b.storage || {});
    if (!keys.length) return;
    let up = 0, skip = 0, fail = 0;
    for (const k of keys) {
      const path = k.replace(/^files\//, ''), cid = path.split('/')[0];
      if (filter && !comms.has(cid)) continue;
      const m = /^data:([^;]*);base64,(.*)$/.exec(b.storage[k]); if (!m) continue;
      const bin = atob(m[2]), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const { error } = await sb.storage.from('files').upload(path, new Blob([u8], { type: m[1] || 'application/octet-stream' }), { upsert: false });
      if (!error) up++; else if (/exist|duplicate|409/i.test(error.message || '')) skip++; else fail++;
    }
    rlog('✓ المرفقات: رُفع ' + up + '، موجود مسبقًا ' + skip + (fail ? '، تعذّر ' + fail : ''), fail ? 'bad' : '');
  }
  window.dmsRestoreLoad = async function (f) {
    if (!f) return;
    const box = document.getElementById('rsBox');
    let b; try { b = JSON.parse(await f.text()); } catch (e) { box.innerHTML = '<p class="bad">ملف غير صالح.</p>'; return; }
    if (!b || b.kind !== 'dms-full-backup' || !b.tables) { box.innerHTML = '<p class="bad">هذا ليس ملف «نسخة شاملة». استخدم الملف الذي يبدأ اسمه بـ «نسخة_شاملة».</p>'; return; }
    RB = b;
    const n = (t) => Array.isArray(b.tables[t]) ? b.tables[t].length : 0;
    const other = b.project && b.project !== CFG.supabaseUrl;
    const deps = (b.tables.departments || []);
    box.innerHTML = `<div style="margin:10px 0;background:#F4F8F6;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13.5px;line-height:1.9">نسخة بتاريخ <b>${esc(fmtDT(b.at))}</b>${other ? ' — <b>من مشروع آخر</b> (نقل الموقع إلى هذا المشروع)' : ''}.
        تحتوي: ${deps.length} أقسام، ${n('committees')} لجان، ${n('profiles')} مستخدمين، ${n('tasks')} مهام، ${n('app_storage')} عنصر من بيانات الأنظمة، ${n('online_submissions')} نتيجة اختبار إلكتروني، ${Object.keys(b.storage || {}).length} مرفقًا.</div>
      <div class="small muted" style="margin-bottom:6px"><b>ما الذي تريد استعادته؟</b></div>
      ${RGROUPS.map((g) => `<label class="check" style="display:flex;gap:8px;margin:6px 0"><input type="checkbox" class="rsG" value="${g.k}" checked><span>${esc(g.label)}${g.hint ? `<br><span class="small muted">${esc(g.hint)}</span>` : ''}</span></label>`).join('')}
      <div class="formgrid" style="margin-top:10px">
        <label class="f">النطاق<select id="rsDept"><option value="">كل الأقسام والكلية</option>${deps.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} فقط</option>`).join('')}</select></label>
        <label class="f">طريقة الاستعادة<select id="rsMode"><option value="missing">إضافة المفقود فقط (لا يُمس الموجود)</option><option value="overwrite">إضافة المفقود واستبدال الموجود بما في النسخة</option></select></label>
      </div>
      <p class="small muted">الاستعادة لا تحذف أي شيء موجود حاليًا. «إضافة المفقود فقط» هي الأسلم لاسترجاع ما حُذف بالخطأ، و«الاستبدال» يعيد السجلات الموجودة إلى حالتها في النسخة.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn primary" id="rsGo" onclick="dmsRestoreRun()">بدء الاستعادة</button></div>
      <div id="rsLog" class="rs-log" aria-live="polite"></div>`;
  };
  window.dmsRestoreRun = async function () {
    if (!isAdmin() || !RB) return;
    const groups = new Set([...document.querySelectorAll('.rsG:checked')].map((x) => x.value));
    if (!groups.size) { alert('اختر ما تريد استعادته.'); return; }
    const d = document.getElementById('rsDept').value, mode = document.getElementById('rsMode').value;
    if (!confirm('بدء الاستعادة' + (mode === 'overwrite' ? ' مع استبدال السجلات الموجودة بما في النسخة' : '') + '؟\n\nيُنصح بتنزيل نسخة شاملة من الوضع الحالي قبل البدء.')) return;
    const btn = document.getElementById('rsGo'); btn.disabled = true; btn.textContent = 'جارٍ الاستعادة…';
    document.getElementById('rsLog').innerHTML = '';
    const filter = deptFilter(RB, d), comms = new Set((RB.tables.committees || []).filter((c) => !d || c.dept_id === d).map((c) => c.id));
    const rows = (t) => (Array.isArray(RB.tables[t]) ? RB.tables[t] : []).filter((r) => !filter || filter(t, r));
    const creds = [['الاسم', 'اسم الدخول', 'كلمة المرور المؤقتة']];
    try {
      for (const g of RGROUPS) {
        if (!groups.has(g.k)) continue;
        rlog('— ' + g.label);
        if (g.k === 'users') { await restoreUsers(RB, filter, mode, creds); continue; }
        for (const t of g.tables) { const r = rows(t); if (r.length) await writeTable(t, r, mode); }
        if (g.k === 'work') await restoreFiles(RB, filter, comms);
      }
      audit('استعادة من نسخة شاملة', fmtDT(RB.at), (d ? deptName(d) : 'الكل') + ' · ' + [...groups].join('،'));
      rlog('اكتملت الاستعادة.', 'good');
      if (creds.length > 1) {
        const csv = '\ufeff' + creds.map((r) => r.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'كلمات_المرور_المؤقتة.csv'; a.click();
        rlog('نُزّل ملف «كلمات_المرور_المؤقتة.csv»: وزّعه على أصحابه ثم احذفه. يُطلب من كل مستخدم تغيير كلمة مروره عند أول دخول.', 'good');
      }
      const done = document.createElement('button'); done.className = 'btn primary'; done.style.marginTop = '10px';
      done.textContent = 'إعادة تحميل الموقع لعرض البيانات المستعادة'; done.onclick = () => location.reload();
      document.getElementById('rsLog').appendChild(done);
    } catch (e) { rlog('توقفت الاستعادة: ' + (e.message || e), 'bad'); }
    btn.disabled = false; btn.textContent = 'بدء الاستعادة';
  };
  function restoreCard() {
    return `<div class="panel"><h3>الاستعادة من نسخة شاملة</h3><div class="body">
      <p class="small">لاسترجاع بيانات حُذفت بالخطأ، أو لنقل الموقع كله إلى مشروع Supabase جديد. اختر ملف النسخة الشاملة، ثم حدد ما تريد استعادته ونطاقه.</p>
      <label class="btn">اختيار ملف النسخة الشاملة<input type="file" accept=".json" class="hidden" onchange="dmsRestoreLoad(this.files[0])"></label>
      <div id="rsBox"></div></div></div>`;
  }
  function localCard() {
    return `<div class="panel"><h3>الملفات المؤقتة على هذا الجهاز</h3><div class="body">
      <p class="small muted">يحفظ المتصفح نسخًا مؤقتة من المرفقات وملفات الأنظمة لتسريع فتحها. مسحها لا يمس بيانات القسم في قاعدة البيانات، ويفيد عند استخدام جهاز مشترك.</p>
      <button class="btn" onclick="wipe()">مسح الملفات المؤقتة وتسجيل الخروج</button></div></div>`;
  }
  /* صفحة النسخ الاحتياطي: النسخة الشاملة والاستعادة فقط (الأقسام القديمة الخاصة بالجهاز الواحد أُزيلت) */
  setBackup = function () {
    if (!isAdmin()) return '<div class="panel"><div class="body">النسخ الاحتياطي من صلاحية المالك.</div></div>';
    return fullBackupCard() + restoreCard() + localCard();
  };
  if (!document.getElementById('rsCss')) { const st = document.createElement('style'); st.id = 'rsCss';
    st.textContent = '.rs-log{margin-top:12px;max-height:280px;overflow:auto;background:#F6F8F7;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.9}.rs-log:empty{display:none}.rs-log .bad{color:var(--bad)}.rs-log .good{color:var(--ok);font-weight:700}';
    document.head.appendChild(st); }

  { const _oh = pgOHome; pgOHome = function () {
      const d = daysSince(DB.settings.lastFullBackup);
      const warn = (isAdmin() && (d === null || d > 7)) ? `<div class="panel" style="border-color:#E6B4B4;background:#FDF3F3"><div class="body" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <b class="bad" style="flex:1;min-width:220px">${d === null ? 'لم تؤخذ نسخة احتياطية شاملة لقاعدة البيانات بعد.' : 'آخر نسخة احتياطية شاملة منذ ' + d + ' يوم.'} الخطة المجانية لا تحفظ نسخًا تلقائية.</b>
        <button class="btn primary" onclick="go('settings',{st:'backup'})">أخذ نسخة الآن</button></div></div>` : '';
      return warn + _oh(); }; }

  /* ================= الهوية والمسميات ================= */
  const LBL_FIELDS = [
    ['siteTitle', 'اسم الموقع (العنوان الكبير في صفحة الدخول)', () => siteTitleAuto()],
    ['siteSub', 'العبارة تحت العنوان', () => 'اضغط على خلية لجنتك للدخول'],
    ['secCollege', 'عنوان قسم «وحدات الكلية»', () => 'وحدات الكلية المشتركة'],
    ['secCollegeSub', 'وصفه', () => 'تخدم كل الأقسام'],
    ['secDepts', 'عنوان قسم «لجان الأقسام»', () => (DB.departments || []).length > 1 ? 'لجان الأقسام' : 'لجان ' + DB.settings.dept],
    ['secDeptsSub', 'وصفه (يظهر عند وجود أكثر من قسم)', () => 'اختر القسم ثم اللجنة'],
    ['secLead', 'عنوان قسم «القيادة والإدارة»', () => 'القيادة والإدارة'],
    ['tileHead', 'اسم خلية «لوحة رئيس القسم»', () => 'لوحة رئيس القسم'],
    ['tileHeadD', 'وصفها', () => 'لرئيس كل قسم: إنجاز لجان قسمه ومؤشراته وخطته'],
    ['tileCollege', 'اسم خلية «لوحة الكلية»', () => 'لوحة الكلية'],
    ['tileCollegeD', 'وصفها', () => 'للعميد والوكلاء: مقارنة الأقسام ووحدات الكلية'],
    ['tileOwner', 'اسم خلية «الإعدادات العامة»', () => 'الإعدادات العامة'],
    ['tileOwnerD', 'وصفها', () => 'خاصة بالمالك: الأقسام والمستخدمون والصلاحيات والأنظمة والمزامنة'],
  ];
  window.setIdentity = function () {
    const L = DB.settings.labels || {};
    return `<div class="panel"><h3>الهوية والمسميات في صفحة الدخول</h3><div class="body">
      <p class="small muted" style="margin-top:0">اكتب النص الذي تريده في أي خانة. <b>الخانة الفارغة تعني استخدام النص الافتراضي الظاهر فيها باهتًا</b>، ويتغير تلقائيًا مع أسماء القسم والكلية.</p>
      <div class="formgrid">${LBL_FIELDS.map(([k, label, def]) => `<label class="f${/D$|Sub$/.test(k) ? '' : ''}">${esc(label)}<input id="lb_${k}" value="${esc(L[k] || '')}" placeholder="${esc(def())}"></label>`).join('')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn primary" onclick="saveIdentity()">حفظ المسميات</button>
        <button class="btn" onclick="if(confirm('إرجاع كل المسميات إلى النصوص الافتراضية؟')){DB.settings.labels={};save();refresh();toast('أُعيدت المسميات الافتراضية')}">إرجاع الافتراضي</button></div></div></div>
      <div class="panel"><h3>أسماء أخرى تُعدَّل من أماكنها</h3><div class="body small">
        <p>• <b>اسم الجامعة والكلية والقسم الأساسي والفصل الدراسي:</b> <a href="#" onclick="go('settings',{st:'general'});return false">تبويب «عام»</a>.</p>
        <p>• <b>أسماء الأقسام وإضافة قسم جديد ورئيسه:</b> <a href="#" onclick="go('depts');return false">إدارة الأقسام</a>. عند إضافة قسم تُنشأ لجانه تلقائيًا ويظهر في صفحة الدخول.</p>
        <p>• <b>أسماء اللجان وألوانها وأيقوناتها وأوصافها:</b> <a href="#" onclick="go('settings',{st:'committees'});return false">تبويب «اللجان»</a>.</p>
        <p class="muted">التغييرات تظهر لكل المستخدمين في صفحة الدخول بعد الحفظ مباشرة.</p></div></div>`;
  };
  window.saveIdentity = function () {
    const L = {};
    LBL_FIELDS.forEach(([k]) => { const v = (document.getElementById('lb_' + k).value || '').trim(); if (v) L[k] = v; });
    DB.settings.labels = L; audit('عدّل المسميات', 'الهوية', Object.keys(L).length + ' نص'); save(); refresh(); toast('تم حفظ المسميات');
  };

  /* ================= التصدير والاستيراد ================= */
  const ROLE_AR = { member: 'عضو', chair: 'رئيس اللجنة', viewer: 'مطّلع' };
  const commName = (id) => { const c = DB.committees.find((x) => x.id === id); return c ? c.name : id; };
  const deptOfComm = (id) => { const c = DB.committees.find((x) => x.id === id); return c ? (c.dept ? deptName(c.dept) : 'مستوى الكلية') : ''; };
  function sheetUsers() {
    return ['المستخدمون', [['الاسم', 'اسم الدخول', 'المسمى', 'الدور العام', 'رئاسة قسم', 'دور الكلية', 'الحالة', 'اللجان والأدوار']].concat(
      DB.users.map((u) => [u.name, u.email && !/@dms\.local$/i.test(u.email) ? u.email : u.username, u.title || '', userRoleLabel(u),
        u.headDept ? deptName(u.headDept) : '', u.collegeRole ? collegeRoleName(u) : '', u.active === false ? 'موقوف' : 'نشط',
        Object.entries(u.memberships || {}).map(([c, r]) => commName(c) + ' (' + (ROLE_AR[r] || r) + ')').join(' ؛ ')]))];
  }
  function sheetTasks() {
    return ['المهام', [['المهمة', 'القسم', 'اللجنة', 'الحالة', 'المسؤول', 'البداية', 'النهاية', 'الإنجاز %', 'متأخرة', 'الفصل']].concat(
      DB.tasks.map((t) => [t.title, deptOfComm(t.committee), commName(t.committee), STATUS[t.status] || t.status || '', uname(t.assignee), t.start || '', t.end || '',
        t.status === 'done' ? 100 : (+t.progress || 0), isLate(t) ? 'نعم' : '', t.term || '']))];
  }
  function sheetKpis() {
    return ['المؤشرات', [['المؤشر', 'القسم', 'اللجنة', 'المعيار', 'المستهدف', 'الفعلي', 'الوحدة', 'الاتجاه', 'محقق', 'الفترة']].concat(
      DB.kpis.map((k) => [k.name, deptOfComm(k.committee), commName(k.committee), k.standard || '', k.target || '', k.actual || '', k.unit || '',
        k.dir === 'down' ? 'الأقل أفضل' : 'الأعلى أفضل', kpiMet(k) ? 'نعم' : 'لا', k.period || '']))];
  }
  function sheetDepts() {
    const stat = (ids) => { const l = DB.tasks.filter((t) => ids.has(t.committee) && t.status !== 'arch'); const avg = l.length ? Math.round(l.reduce((a, t) => a + (t.status === 'done' ? 100 : (+t.progress || 0)), 0) / l.length) : 0;
      return [l.length, l.filter((t) => t.status === 'done').length, l.filter((t) => t.status === 'pend').length, l.filter(isLate).length, avg]; };
    const rows = (DB.departments || []).map((d) => [d.name, (DB.users.find((u) => u.headDept === d.id) || {}).name || '—', ...stat(new Set(DB.committees.filter((c) => c.dept === d.id).map((c) => c.id)))]);
    DB.committees.filter((c) => c.level === 'college').forEach((c) => rows.push([c.name + ' (وحدة كلية)', '—', ...stat(new Set([c.id]))]));
    return ['ملخص الأقسام', [['القسم / الوحدة', 'رئيس القسم', 'المهام', 'المكتملة', 'بانتظار الاعتماد', 'المتأخرة', 'متوسط الإنجاز %']].concat(rows)];
  }
  function sheetLog() {
    return ['سجل الحركات', [['الوقت', 'المستخدم', 'الإجراء', 'العنصر', 'التفاصيل']].concat(
      DB.log.slice().reverse().map((l) => [fmtDT(l.at), uname(l.user), l.action || '', l.entity || '', l.detail || '']))];
  }
  async function sheetsOnline() {
    const [s, e] = await Promise.all([fetchAll('online_submissions'), fetchAll('online_exams')]);
    const ex = Object.fromEntries(e.map((x) => [x.id, x]));
    const dec = (r) => { const t = ((ex[r.online_exam_id] || {}).settings || {}).thresholds || { ready: 80, partial: 60 }; return r.score >= t.ready ? 'جاهز' : r.score >= t.partial ? 'شبه جاهز' : 'غير جاهز'; };
    const all = [['الاختبار', 'القسم', 'الرقم الجامعي', 'الطالب', 'الدرجة %', 'الصحيحة', 'من', 'القرار', 'وقت التسليم', 'المدة (دقيقة)', 'مرات الخروج', 'تسليم تلقائي']].concat(
      s.sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at))).map((r) => [(ex[r.online_exam_id] || {}).title || r.exam_id,
        r.scope === 'college' ? 'مستوى الكلية' : deptName(r.scope), r.student_uid, r.student_name, r.score, r.correct, r.total, dec(r), fmtDT(r.submitted_at),
        r.duration_used ? Math.round(r.duration_used / 60) : '', (r.meta || {}).blur || 0, r.auto ? 'نعم' : '']));
    const sum = [['الاختبار', 'القسم', 'الرمز', 'عدد المسلّمين', 'المتوسط %', 'أعلى %', 'أدنى %', 'نسبة الجاهزين %']].concat(e.map((x) => {
      const l = s.filter((r) => r.online_exam_id === x.id), sc = l.map((r) => r.score), t = (x.settings || {}).thresholds || { ready: 80 };
      return [x.title, x.scope === 'college' ? 'مستوى الكلية' : deptName(x.scope), x.code, l.length, l.length ? Math.round(sc.reduce((a, b) => a + b, 0) / l.length) : '',
        l.length ? Math.max(...sc) : '', l.length ? Math.min(...sc) : '', l.length ? Math.round(l.filter((r) => r.score >= t.ready).length / l.length * 100) : ''];
    }));
    return [['نتائج الاختبارات الإلكترونية', all], ['ملخص الاختبارات', sum]];
  }
  window.dmsExport = async function (kind, btn) {
    if (btn) { btn.disabled = true; }
    try {
      const day = today();
      if (kind === 'users') await exportXlsx('المستخدمون_' + day, [sheetUsers()]);
      else if (kind === 'tasks') await exportXlsx('المهام_' + day, [sheetTasks()]);
      else if (kind === 'kpis') await exportXlsx('المؤشرات_' + day, [sheetKpis()]);
      else if (kind === 'depts') await exportXlsx('ملخص_الأقسام_' + day, [sheetDepts()]);
      else if (kind === 'log') await exportXlsx('سجل_الحركات_' + day, [sheetLog()]);
      else if (kind === 'online') await exportXlsx('نتائج_الاختبارات_الإلكترونية_' + day, await sheetsOnline());
      else if (kind === 'all') await exportXlsx('بيانات_الموقع_' + day, [sheetDepts(), sheetUsers(), sheetTasks(), sheetKpis(), ...(await sheetsOnline()), sheetLog()]);
    } catch (e) { alert('تعذر التصدير: ' + (e.message || e)); }
    if (btn) btn.disabled = false;
  };

  /* --- استيراد المستخدمين من Excel --- */
  const IMP_HEAD = ['الاسم الكامل', 'اسم المستخدم', 'كلمة المرور المؤقتة (اختياري)', 'المسمى', 'اللجنة', 'الدور في اللجنة', 'رئاسة قسم', 'دور الكلية'];
  let IMP = null;
  window.dmsImportTemplate = async function () {
    await exportXlsx('نموذج_استيراد_المستخدمين', [
      ['المستخدمون', [IMP_HEAD,
        ['د. أحمد محمد', 'ahmad.m', '', 'أستاذ مشارك', DB.committees.filter((c) => c.level !== 'college')[0] ? DB.committees.filter((c) => c.level !== 'college')[0].name : '', 'عضو', '', ''],
        ['د. أحمد محمد', 'ahmad.m', '', '', DB.committees.filter((c) => c.level === 'college')[0] ? DB.committees.filter((c) => c.level === 'college')[0].name : '', 'رئيس اللجنة', '', '']]],
      ['اللجان المتاحة', [['اسم اللجنة (انسخه كما هو)', 'القسم']].concat(DB.committees.map((c) => [c.name, c.dept ? deptName(c.dept) : 'مستوى الكلية']))],
      ['الأقسام', [['اسم القسم (لعمود رئاسة قسم)']].concat((DB.departments || []).map((d) => [d.name]))],
      ['تعليمات', [['التعليمات'],
        ['سطر لكل عضوية: إن كان المستخدم عضوًا في أكثر من لجنة فكرر اسمه واسم المستخدم في سطر لكل لجنة.'],
        ['اسم المستخدم بالأحرف الإنجليزية الصغيرة والأرقام، 3 أحرف على الأقل، ولا يتكرر لشخصين.'],
        ['كلمة المرور المؤقتة اختيارية (8 أحرف على الأقل)؛ إن تركتها فارغة تُولَّد تلقائيًا وتصلك في ملف بعد الاستيراد.'],
        ['الدور في اللجنة: عضو، أو رئيس اللجنة، أو مطّلع (قراءة فقط).'],
        ['رئاسة قسم: اكتب اسم القسم كما في ورقة «الأقسام» إن كان المستخدم رئيس قسم، وإلا اتركها فارغة.'],
        ['دور الكلية: عميد أو وكيل، وإلا اتركه فارغًا.'],
        ['المستخدم الموجود مسبقًا لا تتغير كلمة مروره، وتُضاف له العضويات الجديدة فقط.']]]]);
  };
  const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
  window.dmsImportLoad = async function (f) {
    const box = document.getElementById('impBox'); if (!f) return;
    box.innerHTML = '<p class="small muted">جارٍ قراءة الملف…</p>';
    let rows;
    try {
      await ensureXLSX();
      const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    } catch (e) { box.innerHTML = '<p class="bad">تعذرت قراءة الملف. استخدم نموذج Excel من الزر أعلاه.</p>'; return; }
    const hi = rows.findIndex((r) => r.some((c) => norm(c) === 'اسم المستخدم'));
    if (hi < 0) { box.innerHTML = '<p class="bad">لم أجد عمود «اسم المستخدم». استخدم النموذج كما هو دون تغيير العناوين.</p>'; return; }
    const H = rows[hi].map(norm), col = (name) => H.findIndex((h) => h.startsWith(name));
    const cN = col('الاسم'), cU = col('اسم المستخدم'), cP = col('كلمة المرور'), cT = col('المسمى'), cC = col('اللجنة'), cR = col('الدور'), cH = col('رئاسة'), cK = col('دور الكلية');
    const byName = new Map(DB.committees.map((c) => [norm(c.name), c.id])); DB.committees.forEach((c) => byName.set(norm(c.id), c.id));
    const depBy = new Map((DB.departments || []).map((d) => [norm(d.name), d.id]));
    const roleOf = (x) => ({ 'عضو': 'member', 'رئيس': 'chair', 'رئيس اللجنة': 'chair', 'مطلع': 'viewer', 'مطّلع': 'viewer', 'member': 'member', 'chair': 'chair', 'viewer': 'viewer' })[norm(x)] || (norm(x) ? null : 'member');
    const users = new Map();
    rows.slice(hi + 1).forEach((r, i) => {
      const un = norm(r[cU]).toLowerCase(), nm = norm(r[cN]);
      if (!un && !nm) return;
      const u = users.get(un) || { line: hi + i + 2, name: nm, username: un, password: '', title: '', mems: {}, headDept: '', collegeRole: '', errors: [] };
      if (nm && !u.name) u.name = nm;
      if (cP >= 0 && norm(r[cP])) u.password = norm(r[cP]);
      if (cT >= 0 && norm(r[cT])) u.title = norm(r[cT]);
      const cm = cC >= 0 ? norm(r[cC]) : '';
      if (cm) { const id = byName.get(cm); const ro = roleOf(cR >= 0 ? r[cR] : ''); if (!id) u.errors.push('لجنة غير معروفة: «' + cm + '»'); else if (!ro) u.errors.push('دور غير معروف: «' + norm(r[cR]) + '»'); else u.mems[id] = ro; }
      if (cH >= 0 && norm(r[cH])) { const d = depBy.get(norm(r[cH])); if (d) u.headDept = d; else u.errors.push('قسم غير معروف: «' + norm(r[cH]) + '»'); }
      if (cK >= 0 && norm(r[cK])) { const k = ({ 'عميد': 'dean', 'وكيل': 'vice' })[norm(r[cK])]; if (k) u.collegeRole = k; else u.errors.push('دور الكلية يكون «عميد» أو «وكيل»'); }
      users.set(un, u);
    });
    const list = [...users.values()];
    list.forEach((u) => {
      if (!u.name) u.errors.push('الاسم مطلوب');
      if (!/^[a-z0-9._-]{3,}$/.test(u.username)) u.errors.push('اسم المستخدم بالإنجليزية والأرقام، 3 أحرف على الأقل');
      if (u.password && u.password.length < 8) u.errors.push('كلمة المرور 8 أحرف على الأقل');
      u.existing = DB.users.find((x) => x.username.toLowerCase() === u.username) || null;
    });
    IMP = list;
    const ok = list.filter((u) => !u.errors.length), nNew = ok.filter((u) => !u.existing).length, nUpd = ok.length - nNew, nBad = list.length - ok.length;
    box.innerHTML = `<p class="small" style="margin:10px 0"><b>${list.length}</b> مستخدمًا في الملف: <span class="good">${nNew} جديد</span>، ${nUpd} موجود (تُضاف عضوياته فقط)، <span class="${nBad ? 'bad' : ''}">${nBad} فيه أخطاء ولن يُستورد</span>.</p>
      <div class="tbl-wrap" style="max-height:340px;overflow:auto"><table class="t"><tr><th>السطر</th><th>الحالة</th><th>الاسم</th><th>اسم المستخدم</th><th>اللجان</th><th>ملاحظات</th></tr>
      ${list.map((u) => `<tr><td>${u.line}</td><td>${u.errors.length ? '<span class="bad">خطأ</span>' : u.existing ? 'موجود' : '<span class="good">جديد</span>'}</td><td>${esc(u.name)}</td><td dir="ltr">${esc(u.username)}</td>
        <td class="small">${Object.entries(u.mems).map(([c, r]) => esc(commName(c)) + ' (' + ROLE_AR[r] + ')').join('، ') || '—'}${u.headDept ? '<br>رئيس ' + esc(deptName(u.headDept)) : ''}${u.collegeRole ? '<br>' + (u.collegeRole === 'dean' ? 'عميد' : 'وكيل') : ''}</td>
        <td class="small bad">${u.errors.map(esc).join('<br>')}</td></tr>`).join('')}</table></div>
      ${ok.length ? `<div style="margin-top:10px"><button class="btn primary" id="impGo" onclick="dmsImportRun()">استيراد ${ok.length} مستخدمًا</button></div>` : ''}
      <div id="impLog" class="rs-log"></div>`;
  };
  window.dmsImportRun = async function () {
    if (!isAdmin() || !IMP) return;
    const list = IMP.filter((u) => !u.errors.length);
    if (!confirm('استيراد ' + list.length + ' مستخدمًا؟')) return;
    const btn = document.getElementById('impGo'); btn.disabled = true;
    const lg = (t, c) => { const el = document.getElementById('impLog'); const d = document.createElement('div'); d.textContent = t; if (c) d.className = c; el.appendChild(d); el.scrollTop = el.scrollHeight; };
    const creds = [['الاسم', 'اسم الدخول', 'كلمة المرور المؤقتة']];
    let made = 0, upd = 0, fail = 0;
    for (const u of list) {
      let body;
      if (u.existing) body = { action: 'update', appId: u.existing.id, memberships: Object.assign({}, u.existing.memberships || {}, u.mems),
        headDept: u.headDept || undefined, collegeRole: u.collegeRole || undefined };
      else { u.pw = u.password || tmpPass();
        body = { action: 'create', username: u.username, name: u.name, title: u.title, password: u.pw, memberships: u.mems, headDept: u.headDept || '', collegeRole: u.collegeRole || '' }; }
      const { data, error } = await sb.functions.invoke(CFG.usersFunction || 'admin-users', { body });
      if (error || (data && data.error)) { fail++; lg('✗ ' + u.username + ': ' + await fnErr(error, data), 'bad'); continue; }
      if (u.existing) { upd++; lg('✓ ' + u.username + ': أُضيفت العضويات'); } else { made++; creds.push([u.name, u.username, u.pw]); lg('✓ ' + u.username + ': أُنشئ'); }
    }
    audit('استيراد مستخدمين من Excel', made + ' جديد، ' + upd + ' تحديث', fail ? fail + ' تعذّر' : ''); save();
    await reloadUsers();
    lg('اكتمل: ' + made + ' جديد، ' + upd + ' تحديث' + (fail ? '، ' + fail + ' تعذّر' : '') + '.', 'good');
    if (creds.length > 1) { await exportXlsx('كلمات_المرور_المؤقتة_' + today(), [['كلمات المرور المؤقتة', creds]]);
      lg('نُزّل ملف «كلمات_المرور_المؤقتة»: وزّعه على أصحابه ثم احذفه. يُطلب من كل مستخدم تغيير كلمة مروره عند أول دخول.', 'good'); }
    btn.disabled = false;
  };
  window.setDataTab = function () {
    const exp = (k, t, d) => `<button class="btn" style="justify-content:flex-start;text-align:right;display:block;width:100%;padding:12px 14px;white-space:normal;line-height:1.7;height:auto" onclick="dmsExport('${k}',this)"><b>${t}</b><br><span class="small muted" style="font-weight:400">${d}</span></button>`;
    return `<div class="panel"><h3>التصدير إلى Excel</h3><div class="body">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px">
        ${exp('all', 'كل بيانات الموقع في ملف واحد', 'ملخص الأقسام، والمستخدمون، والمهام، والمؤشرات، ونتائج الاختبارات، والسجل؛ كل منها في ورقة')}
        ${exp('online', 'نتائج الاختبارات الإلكترونية', 'كل نتائج الطلاب في كل الاختبارات والأقسام، مع ملخص لكل اختبار')}
        ${exp('users', 'المستخدمون والصلاحيات', 'الأدوار، ورئاسة الأقسام، والعضويات في اللجان')}
        ${exp('tasks', 'كل المهام', 'مع القسم واللجنة والحالة والمسؤول والتواريخ والتأخر')}
        ${exp('kpis', 'المؤشرات', 'المستهدف والفعلي وحالة التحقق')}
        ${exp('depts', 'ملخص الأقسام', 'مقارنة إنجاز الأقسام ووحدات الكلية')}
        ${exp('log', 'سجل الحركات', 'من فعل ماذا ومتى')}
      </div>
      <p class="small muted" style="margin-bottom:0">لكل تقرير في صفحة «التقارير» زرّا تصدير Excel وWord. وبيانات الأنظمة الأربعة (مثل نتائج الجاهزية التفصيلية وجهات التدريب) تُصدَّر من داخل كل نظام.</p></div></div>
      <div class="panel"><h3>استيراد المستخدمين من Excel</h3><div class="body">
        <p class="small" style="margin-top:0">لإضافة عدد كبير من الأعضاء دفعة واحدة، مثل أعضاء قسم جديد: نزّل النموذج، واملأه (سطر لكل عضوية في لجنة)، ثم ارفعه. ستعرض لك معاينة بالأخطاء قبل التنفيذ، وبعده يُنزَّل ملف بكلمات المرور المؤقتة.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" onclick="dmsImportTemplate()">1) تنزيل النموذج</button>
          <label class="btn primary">2) رفع الملف المعبّأ<input type="file" accept=".xlsx,.xls,.csv" class="hidden" onchange="dmsImportLoad(this.files[0]);this.value=''"></label></div>
        <div id="impBox"></div></div></div>`;
  };

  /* ================= تصدير التقارير إلى Word ================= */
  window.exportReportWord = function () {
    const r = curReport(), S = DB.settings;
    const tbl = (rows) => '<table><tr>' + (rows[0] || []).map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr>' +
      rows.slice(1).map((row) => '<tr>' + row.map((c) => '<td>' + esc(c == null ? '' : c) + '</td>').join('') + '</tr>').join('') + '</table>';
    const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8">' +
      '<style>@page{size:A4;margin:2cm}body{font-family:"Sakkal Majalla","Traditional Arabic",Arial;font-size:13pt;direction:rtl}h1{font-size:18pt;text-align:center;color:#1D5445}h2{font-size:14pt;color:#1D5445;margin-top:16pt}' +
      'table{border-collapse:collapse;width:100%;margin:6pt 0}td,th{border:1px solid #9BB6D0;padding:4pt 6pt;font-size:11pt;text-align:center}th{background:#1D5445;color:#fff}.hd{font-size:11pt;color:#555}</style></head>' +
      '<body dir="rtl"><p class="hd">' + esc(S.university) + ' — ' + esc(S.college) + ' — ' + esc(S.dept) + '<br>' + esc(S.term || '') + ' · ' + esc(fmtD(today())) + '</p>' +
      '<h1>' + esc(r.title) + '</h1>' + (r.summary ? '<p>' + r.summary + '</p>' : '') +
      r.tables.map((t) => '<h2>' + esc(t.name) + '</h2>' + tbl(t.rows)).join('') +
      '<p class="hd" style="margin-top:20pt">أعدّه: ' + esc(ME ? ME.name : '') + '</p></body></html>';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + html], { type: 'application/msword' }));
    a.download = r.title.replace(/[\\/:*?"<>|]/g, '_') + '.doc'; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
    audit('تصدير Word', r.title, ''); save();
  };

  /* ================= إدارة الأنظمة: تعطيل، إعادة تسمية، حذف ================= */
  const appMeta = (k) => ((DB.settings.appMeta || {})[k]) || {};
  const setMeta = (k, patch) => { DB.settings.appMeta = DB.settings.appMeta || {}; DB.settings.appMeta[k] = Object.assign({}, DB.settings.appMeta[k] || {}, patch); };
  const multiDept = () => (DB.departments || []).length > 1;
  { const _aa = allApps; allApps = function () {
      const o = _aa();
      Object.keys(o).forEach((k) => { const m = appMeta(k);
        if (m.name) o[k].name = m.name; else if (k === 'readiness' && multiDept()) o[k].name = 'نظام جاهزية الطلاب';
        if (m.desc) o[k].desc = m.desc; o[k].disabled = !!m.disabled; });
      return o; }; }
  { const _sy = systems; systems = function () {
      return _sy().filter((x) => !appMeta(x.k).disabled).map((x) => { const m = appMeta(x.k);
        if (m.name) x.name = m.name; else if (x.k === 'readiness' && multiDept()) x.name = 'نظام جاهزية الطلاب';
        if (m.desc) x.desc = m.desc; return x; }); }; }
  window.dmsSysToggle = function (k) {
    const m = appMeta(k), nm = (allApps()[k] || MODULE_DEF[k] || {}).name || k;
    if (!m.disabled && !confirm('تعطيل «' + nm + '»؟\n\nيختفي من صفحة الدخول ومن اللجان والقوائم لكل المستخدمين، وتبقى بياناته محفوظة. تستطيع تفعيله لاحقًا من هذه الصفحة.')) return;
    setMeta(k, { disabled: !m.disabled }); if (FRAMES[k]) { FRAMES[k].remove(); delete FRAMES[k]; }
    audit(m.disabled ? 'تفعيل نظام' : 'تعطيل نظام', nm, ''); save(); refresh(); toast(m.disabled ? 'فُعّل النظام' : 'عُطّل النظام');
  };
  window.dmsSysRename = function (k) {
    const A = allApps()[k] || MODULE_DEF[k] || {}, m = appMeta(k);
    modal('اسم النظام ووصفه', `<div class="formgrid"><label class="f full">اسم النظام<input id="smN" value="${esc(m.name || '')}" placeholder="${esc(A.name || '')}"></label>
      <label class="f full">الوصف<input id="smD" value="${esc(m.desc || '')}" placeholder="${esc(A.desc || '')}"></label>
      <p class="small muted full">اترك الخانة فارغة لاستخدام الاسم الأصلي.</p></div>`,
      `<button class="btn primary" onclick="dmsSysRenameSave('${k}')">حفظ</button><button class="btn" onclick="closeModal()">إلغاء</button>`);
  };
  window.dmsSysRenameSave = function (k) { setMeta(k, { name: val('smN'), desc: val('smD') }); audit('تعديل اسم نظام', val('smN') || k, ''); save(); closeModal(); refresh(); };
  window.dmsSysDataDlg = async function (k) {
    const A = allApps()[k] || {}, custom = !!A.custom;
    const { data, error } = await sb.from('app_storage').select('scope,key').eq('app_key', k);
    if (error) { alert(error.message); return; }
    const per = {}; (data || []).forEach((r) => { per[r.scope] = (per[r.scope] || 0) + 1; });
    const scopes = Object.keys(per);
    const lbl = (sc) => sc === 'college' ? 'مستوى الكلية' : deptName(sc);
    modal(custom ? 'حذف النظام وبياناته' : 'حذف بيانات النظام', `<p>${custom ? 'سيُحذف «' + esc(A.name) + '» من الموقع نهائيًا مع إصداراته وبياناته المختارة أدناه.'
        : '«' + esc(A.name) + '» نظام أساسي في الموقع: يمكنك <b>حذف بياناته</b> لقسم معين أو للكل، أو <b>تعطيله</b> ليختفي من الموقع مع بقاء بياناته.'}</p>
      ${scopes.length ? `<label class="f">البيانات المراد حذفها<select id="sdS"><option value="*">كل الأقسام (${data.length} عنصرًا)</option>${scopes.map((sc) => `<option value="${esc(sc)}">${esc(lbl(sc))} فقط (${per[sc]} عنصرًا)</option>`).join('')}</select></label>`
        : '<p class="small muted">لا توجد بيانات محفوظة لهذا النظام.</p>'}
      <p class="small bad" style="margin-top:12px"><b>لا يمكن التراجع عن الحذف.</b> نزّل نسخة شاملة أولًا لتستطيع الاستعادة إن احتجت.</p>
      <label class="f">للتأكيد اكتب كلمة «حذف»<input id="sdC" autocomplete="off"></label>`,
      `<button class="btn" onclick="dmsFullBackup(this)">تنزيل نسخة شاملة أولًا</button><span class="sp" style="flex:1"></span>
       <button class="btn danger" onclick="dmsSysDataRun('${k}')">${custom ? 'حذف النظام' : 'حذف البيانات'}</button><button class="btn" onclick="closeModal()">إلغاء</button>`);
  };
  window.dmsSysDataRun = async function (k) {
    if ((val('sdC') || '').trim() !== 'حذف') { alert('اكتب كلمة «حذف» للتأكيد.'); return; }
    const A = allApps()[k] || {}, sel = document.getElementById('sdS'), sc = sel ? sel.value : '*';
    let q = sb.from('app_storage').select('scope,key').eq('app_key', k); if (sc !== '*') q = q.eq('scope', sc);
    const { data } = await q; let n = 0, fail = 0;
    for (const r of (data || [])) { const { error } = await sb.rpc('app_storage_del', { p_app: k, p_scope: r.scope, p_key: r.key }); if (error) fail++; else n++; }
    Object.keys(localStorage).filter((x) => x.startsWith('dmsapp:' + k + '|' + (sc === '*' ? '' : sc))).forEach((x) => localStorage.removeItem(x));
    if (FRAMES[k]) { FRAMES[k].remove(); delete FRAMES[k]; }
    if (A.custom) { DB.customApps = DB.customApps.filter((x) => x.id !== k); delete DB.appVersions[k]; if (DB.settings.appMeta) delete DB.settings.appMeta[k]; }
    audit(A.custom ? 'حذف نظام' : 'حذف بيانات نظام', A.name || k, (sc === '*' ? 'كل الأقسام' : (sc === 'college' ? 'مستوى الكلية' : deptName(sc))) + ' · ' + n + ' عنصر');
    save(); closeModal(); refresh();
    toast((A.custom ? 'حُذف النظام' : 'حُذفت البيانات') + ' (' + n + ' عنصر' + (fail ? '، تعذّر ' + fail : '') + ')');
  };
  { const _ss = setSystems; setSystems = function () {
      let h = _ss();
      /* أزرار الإدارة في ترويسة كل نظام */
      Object.entries(allApps()).forEach(([k, x]) => {
        const m = appMeta(k);
        const btns = `${m.disabled ? '<span class="pill st-late">معطّل</span>' : ''}<button class="btn sm" onclick="dmsSysRename('${k}')">الاسم</button><button class="btn sm" onclick="dmsSysToggle('${k}')">${m.disabled ? 'تفعيل' : 'تعطيل'}</button><button class="btn sm danger" onclick="dmsSysDataDlg('${k}')">${x.custom ? 'حذف النظام' : 'حذف البيانات'}</button>`;
        h = h.replace(`<button class="btn sm primary" onclick="uploadVersionDlg('${k}')">رفع تحديث</button>`, btns + `<button class="btn sm primary" onclick="uploadVersionDlg('${k}')">رفع تحديث</button>`);
      });
      const mods = Object.entries(MODULE_DEF).map(([k, d]) => { const m = appMeta(k);
        return `<tr><td><b>${esc(m.name || d.name)}</b><div class="small muted">${esc(m.desc || d.desc || '')}</div></td><td>${m.disabled ? '<span class="pill st-late">معطّل</span>' : '<span class="pill st-done">مفعّل</span>'}</td>
          <td style="white-space:nowrap"><button class="btn sm" onclick="dmsSysRename('${k}')">الاسم</button> <button class="btn sm" onclick="dmsSysToggle('${k}')">${m.disabled ? 'تفعيل' : 'تعطيل'}</button></td></tr>`; }).join('');
      h += `<div class="panel"><h3>وحدات الموقع المدمجة</h3><div class="body"><div class="tbl-wrap"><table class="t"><tr><th>الوحدة</th><th>الحالة</th><th></th></tr>${mods}</table></div></div></div>
        <div class="panel"><h3>كيف تعمل الأنظمة مع تعدد الأقسام</h3><div class="body small">
          <p>• الأنظمة المرتبطة بلجنة على <b>مستوى القسم</b> (الجاهزية والاستطلاعات) لها <b>بيانات مستقلة لكل قسم</b>: اختبارات الجاهزية وطلاب قسم المحاسبة منفصلة تمامًا عن قسم إدارة الأعمال، وكذلك الاختبارات الإلكترونية ونتائجها. والقسم الجديد يبدأ نظامه فارغًا باسمه.</p>
          <p>• الأنظمة المرتبطة بلجنة على <b>مستوى الكلية</b> (التدريب والاختبارات) <b>مشتركة</b> بين الأقسام لأنها وحدة واحدة للكلية. إن أردت أن يكون لكل قسم نظامه المستقل فاجعل لجنتها على مستوى القسم من تبويب «اللجان».</p>
          <p>• عند فتح أي نظام من «الإعدادات العامة» أو «لوحة الكلية» تختار القسم الذي تريد بياناته من القائمة في شريط النظام.</p>
          <p>• <b>التعطيل</b> يخفي النظام من كل مكان ويبقي بياناته، و<b>حذف البيانات</b> نهائي (خذ نسخة شاملة قبله).</p></div></div>`;
      return h; }; }

  /* ================= لكل قسم مقرراته ودكاترته وبرامجه ================= */
  const courseDept = (c) => c.dept || primaryDept();
  function deptLists() {
    const S = DB.settings, pid = primaryDept();
    if (!S.deptFaculty) S.deptFaculty = pid ? { [pid]: (S.faculty || []).slice() } : {};
    if (!S.deptPrograms) S.deptPrograms = pid ? { [pid]: (S.programs || []).slice() } : {};
  }
  function syncUnions() {
    deptLists(); const S = DB.settings, uniq = (a) => [...new Set(a.filter(Boolean))];
    S.faculty = uniq(Object.values(S.deptFaculty).flat());
    S.programs = uniq(Object.values(S.deptPrograms).flat());
  }
  /* تبويب «عام»: القائمتان تُجمعان تلقائيًا من الأقسام */
  { const _sg = setGeneral; setGeneral = function () {
      deptLists();
      return _sg().replace('<label class="f full">البرامج (سطر لكل برنامج)<textarea id="sPr">', '<label class="f full">البرامج في كل الأقسام <span class="small muted">(تُعدَّل لكل قسم من «إدارة الأقسام»)</span><textarea id="sPr" readonly style="background:#F6F8F7">')
        .replace('<label class="f full">أعضاء هيئة التدريس (سطر لكل عضو)<textarea id="sF" style="min-height:140px">', '<label class="f full">أعضاء هيئة التدريس في كل الأقسام <span class="small muted">(تُعدَّل لكل قسم من «إدارة الأقسام»)</span><textarea id="sF" readonly style="min-height:140px;background:#F6F8F7">');
    }; }
  /* نافذة القسم: دكاترته وبرامجه */
  { const _od = window.openDept, _sd = window.saveDept;
    window.openDept = function (id) {
      _od(id); deptLists();
      const S = DB.settings, err = document.getElementById('dpErr'); if (!err) return;
      const fac = id ? (S.deptFaculty[id] || []) : [], pr = id ? (S.deptPrograms[id] || []) : [];
      err.insertAdjacentHTML('beforebegin', `<label class="f full">أعضاء هيئة التدريس في القسم (سطر لكل عضو)<textarea id="dpF" style="min-height:110px">${esc(fac.join('\n'))}</textarea></label>
        <label class="f full">برامج القسم (سطر لكل برنامج)<textarea id="dpP">${esc(pr.join('\n'))}</textarea></label>`);
    };
    window.saveDept = function (id) {
      const fe = document.getElementById('dpF'), pe = document.getElementById('dpP'), nm = val('dpN');
      const fac = fe ? fe.value.split('\n').map((x) => x.trim()).filter(Boolean) : null, pr = pe ? pe.value.split('\n').map((x) => x.trim()).filter(Boolean) : null;
      _sd(id);
      const d = id ? deptById(id) : (DB.departments || []).find((x) => x.name === nm);
      if (!d || (fac === null && pr === null)) return;
      deptLists(); if (fac !== null) DB.settings.deptFaculty[d.id] = fac; if (pr !== null) DB.settings.deptPrograms[d.id] = pr;
      syncUnions(); save();
    }; }
  /* تبويب المقررات حسب القسم */
  setCourses = function () {
    const S = DB.settings, deps = DB.departments || [], f = VIEW.cdept || '';
    const rows = S.courses.map((c, i) => ({ c, i })).filter((x) => !f || courseDept(x.c) === f);
    const chips = deps.length > 1 ? `<div class="dept-chips" style="margin:0 0 12px">${[['', 'كل الأقسام (' + S.courses.length + ')']].concat(deps.map((d) => [d.id, d.name + ' (' + S.courses.filter((c) => courseDept(c) === d.id).length + ')'])).map(([k, l]) =>
      `<button class="${f === k ? 'on' : ''}" onclick="go('settings',{st:'courses',cdept:'${k}'})">${esc(l)}</button>`).join('')}</div>` : '';
    return `<div class="panel"><h3>المقررات ومخرجات التعلم<span class="sp"></span>
        <button class="btn sm" onclick="dmsCoursesTemplate()">نموذج Excel</button>
        <label class="btn sm">استيراد من Excel<input type="file" accept=".xlsx,.xls,.csv" class="hidden" onchange="dmsCoursesImport(this.files[0]);this.value=''"></label>
        <button class="btn sm primary" onclick="editCourse()">مقرر جديد</button></h3><div class="body">${chips}
      <div class="tbl-wrap"><table class="t"><tr><th>المقرر</th><th>الرمز</th>${deps.length > 1 ? '<th>القسم</th>' : ''}<th>المخرجات</th></tr>
      ${rows.map(({ c, i }) => `<tr class="click" onclick="editCourse(${i})"><td>${esc(c.name)}</td><td class="small">${esc(c.code)}</td>${deps.length > 1 ? `<td class="small">${esc(deptName(courseDept(c)))}</td>` : ''}<td class="small muted">${(c.clos || []).filter(Boolean).length} مخرجات</td></tr>`).join('') || `<tr><td colspan="4" class="muted">لا توجد مقررات${f ? ' لهذا القسم' : ''}. أضفها يدويًا أو استوردها من Excel.</td></tr>`}</table></div>
      <p class="small muted" style="margin-bottom:0">مقررات كل قسم تظهر في «قياس مخرجات التعلم». ومقررات اختبار الجاهزية وأسئلته تُدار من داخل نظام الجاهزية لكل قسم.</p></div></div>`;
  };
  editCourse = function (i) {
    const c = i != null ? DB.settings.courses[i] : { name: '', code: '', dept: VIEW.cdept || primaryDept(), clos: ['', '', '', ''] };
    const deps = DB.departments || [];
    modal(i != null ? 'تعديل مقرر' : 'مقرر جديد', `<div class="formgrid"><label class="f full">اسم المقرر<input id="coN" value="${esc(c.name)}"></label>
      <label class="f">الرمز<input id="coC" value="${esc(c.code)}"></label>
      ${deps.length > 1 ? `<label class="f">القسم<select id="coD">${deps.map((d) => `<option value="${esc(d.id)}"${courseDept(c) === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>` : '<span></span>'}
      ${[0, 1, 2, 3].map((j) => `<label class="f full">مخرج التعلم ${j + 1}<input id="coL${j}" value="${esc((c.clos || [])[j] || '')}"></label>`).join('')}</div>`,
      `<button class="btn primary" onclick="saveCourse(${i != null ? i : 'null'})">حفظ المقرر</button>${i != null ? `<span class="sp"></span><button class="btn danger" onclick="if(confirm('حذف المقرر؟')){DB.settings.courses.splice(${i},1);save();closeModal();refresh()}">حذف</button>` : ''}`);
  };
  saveCourse = function (i) {
    const c = { name: val('coN'), code: val('coC'), dept: document.getElementById('coD') ? val('coD') : primaryDept(), clos: [0, 1, 2, 3].map((j) => val('coL' + j)) };
    if (!c.name) { alert('اكتب اسم المقرر.'); return; }
    if (i != null) DB.settings.courses[i] = c; else DB.settings.courses.push(c);
    audit(i != null ? 'عدّل مقررًا' : 'أضاف مقررًا', c.name, deptName(c.dept)); save(); closeModal(); refresh();
  };
  window.dmsCoursesTemplate = async function () {
    const d0 = deptName(VIEW.cdept || primaryDept());
    await exportXlsx('نموذج_استيراد_المقررات', [
      ['المقررات', [['القسم', 'اسم المقرر', 'الرمز', 'مخرج التعلم 1', 'مخرج التعلم 2', 'مخرج التعلم 3', 'مخرج التعلم 4'],
        [d0, 'مبادئ المحاسبة المالية', 'ACC 101', 'يشرح المفاهيم المحاسبية الأساسية', 'يسجل العمليات المالية', 'يعد القوائم المالية', '']]],
      ['الأقسام', [['اسم القسم (انسخه كما هو)']].concat((DB.departments || []).map((d) => [d.name]))],
      ['المقررات الحالية', [['القسم', 'اسم المقرر', 'الرمز']].concat(DB.settings.courses.map((c) => [deptName(courseDept(c)), c.name, c.code]))]]);
  };
  window.dmsCoursesImport = async function (f) {
    if (!f) return;
    let rows;
    try { await ensureXLSX(); const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' }); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }); }
    catch (e) { alert('تعذرت قراءة الملف. استخدم «نموذج Excel».'); return; }
    const n2 = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
    const hi = rows.findIndex((r) => r.some((c) => n2(c) === 'اسم المقرر'));
    if (hi < 0) { alert('لم أجد عمود «اسم المقرر». استخدم النموذج دون تغيير العناوين.'); return; }
    const H = rows[hi].map(n2), col = (n) => H.indexOf(n);
    const cD = col('القسم'), cN = col('اسم المقرر'), cC = col('الرمز'), cL = [1, 2, 3, 4].map((j) => col('مخرج التعلم ' + j));
    const depBy = new Map((DB.departments || []).map((d) => [n2(d.name), d.id]));
    let add = 0, upd = 0; const bad = [];
    rows.slice(hi + 1).forEach((r, k) => {
      const name = n2(r[cN]); if (!name) return;
      const dn = cD >= 0 ? n2(r[cD]) : '', dept = dn ? depBy.get(dn) : (VIEW.cdept || primaryDept());
      if (!dept) { bad.push('السطر ' + (hi + k + 2) + ': قسم غير معروف «' + dn + '»'); return; }
      const c = { name, code: cC >= 0 ? n2(r[cC]) : '', dept, clos: cL.map((ci) => ci >= 0 ? n2(r[ci]) : '') };
      const i = DB.settings.courses.findIndex((x) => courseDept(x) === dept && ((c.code && x.code === c.code) || x.name === c.name));
      if (i >= 0) { DB.settings.courses[i] = c; upd++; } else { DB.settings.courses.push(c); add++; }
    });
    if (!add && !upd) { alert('لم يُستورد أي مقرر.' + (bad.length ? '\n\n' + bad.slice(0, 10).join('\n') : '')); return; }
    audit('استيراد مقررات من Excel', add + ' جديد، ' + upd + ' تحديث', bad.length ? bad.length + ' خطأ' : ''); save(); refresh();
    alert('تم: ' + add + ' مقرر جديد، و' + upd + ' مقرر حُدّث.' + (bad.length ? '\n\nلم يُستورد ' + bad.length + ' سطرًا:\n' + bad.slice(0, 10).join('\n') : ''));
  };

  /* ---------- التشغيل ---------- */
  function applyBootstrap(b) {
    const s = b.settings || {};
    Object.keys(s).forEach((k) => { if (s[k] != null) DB.settings[k] = s[k]; });
    if (b.departments && b.departments.length) DB.departments = b.departments.map(depFrom);
    if (b.committees && b.committees.length) DB.committees = b.committees.map(commFrom);
    DB.customApps = (b.custom_apps || []).map((r) => Object.assign({}, r.data || {}, { id: r.id }));
    normalize(DB);
  }
  boot = async function () {
    DB = freshDB(); normalize(DB);
    const linkBtn = document.querySelector('button[onclick="linkDeviceDlg()"]'); if (linkBtn) linkBtn.remove();
    let hasAdmin = true;
    try { const { data, error } = await sb.rpc('public_bootstrap'); if (error) throw error; applyBootstrap(data || {}); hasAdmin = !!(data && data.has_admin); }
    catch (e) { $('#lgHint').innerHTML = '<span class="bad">تعذر الاتصال بقاعدة البيانات: ' + esc(e.message || e) + '</span>'; }
    const S = DB.settings;
    document.title = siteTitle();
    renderLanding();
    if (!hasAdmin) $('#lgHint').textContent = 'لم يُنشأ حساب المالك بعد. أنشئه بسكربت create-owner كما في دليل التشغيل.';
    const ss = readSession();
    const { data: { session } } = await sb.auth.getSession();
    if (session && ss) {
      try {
        const u = await loadAll(session.user.id);
        if (u && u.id === ss.u && u.active !== false && scopeAllowed(u, ss.scope)) { ME = u; SCOPE = ss.scope; startRealtime(); enter(); return; }
      } catch (e) { console.error(e); }
    }
    if (session) await sb.auth.signOut();
  };
  boot();
})();
