/* الإصدار 3.0: تقارير إضافية — تقرير فترة (يومي/أسبوعي/مخصص)، تقرير حسب القسم، تقرير حسب حالة العمل.
   تُطبع وتُصدَّر إلى Excel بالأزرار الموجودة في صفحة التقارير. */
(function () {
  Object.assign(REPORTS, { period: 'تقرير فترة (يومي / أسبوعي / مخصص)', dept: 'تقرير حسب القسم', status: 'تقرير حسب حالة العمل' });
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return ymd(x); };
  function range() {
    const t0 = today(), p = VIEW.p || 'week';
    if (p === 'day') return [t0, t0, 'اليوم ' + fmtD(t0)];
    if (p === 'week') { const w = new Date(t0 + 'T00:00:00').getDay(); const s = addDays(t0, -w); return [s, addDays(s, 6), 'الأسبوع ' + fmtD(s) + ' – ' + fmtD(addDays(s, 6))]; }
    if (p === 'month') { const s = t0.slice(0, 8) + '01'; const e = ymd(new Date(new Date(s + 'T00:00:00').getFullYear(), new Date(s + 'T00:00:00').getMonth() + 1, 0)); return [s, e, 'الشهر ' + t0.slice(0, 7)]; }
    const f = VIEW.from || addDays(t0, -7), to = VIEW.to || t0; return [f, to, fmtD(f) + ' – ' + fmtD(to)];
  }
  const inR = (d, a, b) => !!d && d.slice(0, 10) >= a && d.slice(0, 10) <= b;
  const statusName = (t) => isLate(t) ? 'متأخر' : (STATUS[t.status] || '—');
  const _br = buildReport;
  buildReport = function (r, o) {
    const ts = visibleTasks();
    if (r === 'period') {
      const [a, b, lbl] = range();
      const created = ts.filter((t) => inR(t.createdAt, a, b)), done = ts.filter((t) => t.status === 'done' && inR(t.approvedAt || t.updatedAt, a, b)), due = ts.filter((t) => inR(t.end, a, b));
      const cs = myCommittees().filter((c) => ts.some((t) => t.committee === c.id));
      return { title: 'تقرير ' + lbl, summary: `أُنشئت ${created.length} مهمة، واكتملت ${done.length}، ويستحق خلال الفترة ${due.length}، والمتأخر حاليًا ${ts.filter(isLate).length}.`,
        tables: [{ name: 'ملخص اللجان خلال الفترة', rows: [['اللجنة', 'أُنشئت', 'اكتملت', 'تستحق', 'متأخرة الآن'], ...cs.map((c) => { const f = (l) => l.filter((t) => t.committee === c.id).length; return [c.name, f(created), f(done), f(due), f(ts.filter(isLate))]; })] },
          { name: 'المهام المكتملة', rows: [TASK_HEAD, ...done.map(taskRow)] }, { name: 'المهام المستحقة', rows: [TASK_HEAD, ...due.map(taskRow)] }, { name: 'المهام الجديدة', rows: [TASK_HEAD, ...created.map(taskRow)] }] };
    }
    if (r === 'dept') {
      const deps = (DB.departments || []).filter((d) => DB.committees.some((c) => c.dept === d.id && roleIn(c.id)));
      const stat = (ids) => { const l = ts.filter((t) => ids.has(t.committee)); const d = l.filter((t) => t.status === 'done').length;
        return [l.length, d, l.filter((t) => t.status === 'pend').length, l.filter(isLate).length, (l.length ? Math.round(l.reduce((s, t) => s + (t.status === 'done' ? 100 : (+t.progress || 0)), 0) / l.length) : 0) + '%']; };
      const rows = deps.map((d) => [d.name, (DB.users.find((u) => u.headDept === d.id) || {}).name || '—', ...stat(new Set(DB.committees.filter((c) => c.dept === d.id).map((c) => c.id)))]);
      const cu = DB.committees.filter((c) => c.level === 'college' && roleIn(c.id));
      if (cu.length) rows.push(['وحدات الكلية', '—', ...stat(new Set(cu.map((c) => c.id)))]);
      const sel = VIEW.dp || (deps[0] || {}).id;
      const selC = DB.committees.filter((c) => c.dept === sel && roleIn(c.id));
      return { title: REPORTS.dept, summary: `${deps.length} قسم ضمن صلاحياتك.`,
        tables: [{ name: 'مقارنة الأقسام', rows: [['القسم', 'رئيس القسم', 'المهام', 'مكتملة', 'بانتظار الاعتماد', 'متأخرة', 'متوسط الإنجاز'], ...rows] },
          ...(sel ? [{ name: 'لجان ' + deptName(sel), rows: [['اللجنة', 'المهام', 'مكتملة', 'جارية', 'بانتظار الاعتماد', 'متأخرة', 'متوسط الإنجاز'], ...selC.map((c) => { const s = commStats(c.id); return [c.name, s.n, s.done, s.prog, s.pend, s.late, s.avg + '%']; })] }] : [])] };
    }
    if (r === 'status') {
      const groups = {}; ts.forEach((t) => { const k = statusName(t); (groups[k] = groups[k] || []).push(t); });
      const order = ['متأخر', STATUS.pend, STATUS.prog, STATUS.ret, STATUS.not, STATUS.done].filter((k) => groups[k]);
      Object.keys(groups).forEach((k) => { if (!order.includes(k)) order.push(k); });
      return { title: REPORTS.status, summary: order.map((k) => `${k}: ${groups[k].length}`).join(' · '),
        tables: [{ name: 'ملخص الحالات', rows: [['الحالة', 'عدد المهام', 'النسبة'], ...order.map((k) => [k, groups[k].length, Math.round(groups[k].length / Math.max(ts.length, 1) * 100) + '%'])] },
          ...order.map((k) => ({ name: k, rows: [TASK_HEAD, ...groups[k].map(taskRow)] }))] };
    }
    return _br(r, o);
  };
  const _pr = pgReports;
  pgReports = function () {
    let h = _pr(); const r = VIEW.r;
    let extra = '';
    if (r === 'period') {
      const p = VIEW.p || 'week';
      extra = `<select onchange="go('reports',Object.assign(VIEW,{p:this.value}))" style="width:auto">${opt([{ v: 'day', l: 'اليوم' }, { v: 'week', l: 'هذا الأسبوع' }, { v: 'month', l: 'هذا الشهر' }, { v: 'custom', l: 'فترة مخصصة' }], p)}</select>`
        + (p === 'custom' ? `<input type="date" value="${esc(VIEW.from || '')}" onchange="go('reports',Object.assign(VIEW,{from:this.value}))" style="width:auto"><input type="date" value="${esc(VIEW.to || today())}" onchange="go('reports',Object.assign(VIEW,{to:this.value}))" style="width:auto">` : '');
    }
    if (r === 'dept') {
      const deps = (DB.departments || []).filter((d) => DB.committees.some((c) => c.dept === d.id && roleIn(c.id)));
      if (deps.length > 1) extra = `<select onchange="go('reports',Object.assign(VIEW,{dp:this.value}))" style="width:auto">${opt(deps.map((d) => ({ v: d.id, l: d.name })), VIEW.dp || deps[0].id)}</select>`;
    }
    if (extra) h = h.replace('<span style="flex:1"></span>', extra + '<span style="flex:1"></span>');
    return h;
  };
})();
