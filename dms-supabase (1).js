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

  async function pushCommittees() {
    const base = BASE.committees, admin = isAdmin();
    const cur = new Map(DB.committees.map((c) => [c.id, c]));
    let ok = true;
    for (const [id, c] of cur) {
      const j = JSON.stringify(commRow(c));
      if (base.get(id) === j) continue;
      if (!base.has(id) && !admin) continue;
      if (base.has(id) && !admin && !isChair(id)) continue;
      const { error } = await sb.from('committees').upsert([commRow(c)]);
      if (!error) base.set(id, j); else if (isNetErr(error)) { ok = false; LAST_ERR = error.message; } else { denied(error); base.set(id, j); }
    }
    if (admin) for (const id of [...base.keys()]) if (!cur.has(id)) {
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
      ok = (await pushCommittees()) && ok;
      ok = (await pushUsers()) && ok;
      if (isAdmin()) {
        const sj = J(DB.settings);
        if (BASE.settings !== sj) { const { error } = await sb.from('settings').upsert([{ id: 1, data: clean(DB.settings) }]); if (!error) BASE.settings = sj; else ok = false; }
      }
      ok = (await pushSimpleAdmin('customApps', 'custom_apps', DB.customApps || [], (x) => ({ id: x.id, data: clean(x) }))) && ok;
      ok = (await pushAppVersions()) && ok;
      for (const C of ['goals', 'templates', 'tasks', 'kpis', 'visits', 'clo', 'files', 'initiatives', 'events', 'collegeEvents', 'notifs', 'log'])
        ok = (await pushColl(C)) && ok;
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
    refreshTimer = setTimeout(() => { if (!ME) return; try { updateBell(); softRefresh(); } catch (e) { console.error(e); } }, 350);
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
    const sc = appScope(a);
    if (FRAMES[a] && FRAMES[a].dataset.scope !== sc) { FRAMES[a].remove(); delete FRAMES[a]; }
    await _openTool(a);
    if (FRAMES[a]) FRAMES[a].dataset.scope = sc;
    const bar = $('#toolBar');
    if (bar && !document.getElementById('appScopeLbl')) {
      const lbl = document.createElement('span'); lbl.id = 'appScopeLbl'; lbl.className = 'pill st-prog';
      lbl.textContent = 'بيانات: ' + (sc === 'college' ? 'مستوى الكلية' : deptName(sc)); bar.insertBefore(lbl, bar.children[1] || null);
      if (isAdmin() || isChair(allApps()[a].committee)) {
        const b = document.createElement('label'); b.className = 'btn sm'; b.textContent = 'استيراد بيانات من النسخة السابقة';
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
