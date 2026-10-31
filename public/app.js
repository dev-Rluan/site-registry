const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kinds = {feature:'기능 정의',criterion:'검토 기준',policy:'업무 정책',document:'참고 문서',raw_data:'원데이터'};
const states = {draft:'초안 · 검토 대기',approved:'승인됨',rejected:'반려됨'};
const tabs = ['materials','analyses','batches','config','context'];
let sites = [], active = null, detail = null, editing = null, editingAnalysis = null, reviewing = null, tab = 'materials', timer;

function status(message, error = false) {
  clearTimeout(timer); $('#status').textContent = message; $('#status').className = error ? 'error' : '';
  timer = setTimeout(() => $('#status').textContent = '', 6000);
}
async function api(path, method = 'GET', data) {
  const response = await fetch(path, {method, headers:data ? {'Content-Type':'application/json'} : {}, body:data ? JSON.stringify(data) : undefined});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '요청에 실패했습니다.');
  return result;
}
const date = value => value ? new Date(value).toLocaleString('ko-KR') : '';
const approved = material => material.versions.find(v => v.revision === material.approved_revision);

async function refresh(siteId = active) {
  sites = await api('/api/sites'); active = siteId || sites[0]?.id || null;
  $('#site-count').textContent = sites.length;
  $('#sites').innerHTML = sites.map(s => `<button class="site-button ${s.id === active ? 'selected' : ''}" data-site="${s.id}" aria-pressed="${s.id === active}"><span>${esc(s.slug)}</span><strong>${esc(s.name)}</strong><small>근거 ${s.material_count}개 · 설정 ${s.config_revision ? 'v' + s.config_revision : '미등록'}</small></button>`).join('');
  $('#empty').hidden = Boolean(active); $('#detail').hidden = !active;
  if (active) { detail = await api(`/api/sites/${active}`); render(); }
}
function render() {
  const s = detail.site;
  $('#site-slug').textContent = s.slug.toUpperCase(); $('#site-name').textContent = s.name;
  $('#site-description').textContent = s.description; $('#connection-slug').textContent = s.slug;
  $('#materials').innerHTML = detail.materials.length ? detail.materials.map(m => `<article class="card" data-material="${m.id}">
    <div class="material-meta"><span class="kind">${kinds[m.kind] || esc(m.kind)}</span><span>자료 #${m.id} · 최신 v${m.revision}</span><span class="state ${esc(m.status || 'draft')}">${states[m.status || 'draft']}</span></div>
    <div class="material-head"><h4 class="material-title">${esc(m.title)}</h4><button class="text-button" data-edit="${m.id}">새 버전 작성</button></div>
    <p class="baseline">${m.approved_revision ? `현재 기준본 v${m.approved_revision}${m.approved_revision !== m.revision ? ' · 새 초안과 별도로 유지 중' : ''}` : '승인된 기준본 없음 · MCP 미제공'}</p>
    <p class="material-body">${esc(m.body)}</p><p class="source">출처: ${esc(m.source || '미입력')} · ${esc(date(m.created_at))}</p>
    ${m.status === 'draft' ? `<button class="secondary review-button" data-review="${m.id}">v${m.revision} 검토·승인</button>` : `<p class="source">검토: ${esc(m.reviewer || '미기록')} · ${esc(date(m.reviewed_at))}${m.note ? ' · ' + esc(m.note) : ''}</p>`}
    <details class="versions"><summary>버전 기록 ${m.versions.length}개</summary>${m.versions.map(v => `<div class="version-line"><strong>v${v.revision} · ${states[v.status || 'draft']}</strong> · ${esc(date(v.created_at))}${v.reviewer ? ' · 검토자 ' + esc(v.reviewer) : ''}<pre>${esc(v.title)}\n${esc(v.body)}\n출처: ${esc(v.source || '미입력')}${v.note ? '\n검토 의견: ' + esc(v.note) : ''}</pre></div>`).join('')}</details></article>`).join('') : '<div class="card muted">아직 근거가 없습니다. 아래에서 기능 정의나 정책 초안을 등록하세요.</div>';
  const c = detail.config;
  $('#config-state').innerHTML = `<div class="section-line"><strong>${c.revision ? '설정 v' + c.revision + ' 저장됨' : '설정 미등록'}</strong><span class="tag">설정값 비공개</span></div><p class="help">${c.revision ? '암호화된 버전 ' + c.versions.length + '개를 보존하고 있습니다.' : '새 JSON 설정을 입력하면 암호화하여 저장합니다.'}</p>${c.versions.map(v => `<div class="version-line">v${v.revision} · 항목 ${v.field_count}개 · ${esc(date(v.created_at))}</div>`).join('')}`;
  $('#site-info').innerHTML = `<p class="eyebrow">SITE INFORMATION</p><h3>${esc(s.name)}</h3><p class="help">${esc(s.slug)} · ${esc(s.description)}</p>`;
  $('#batches').innerHTML = (detail.batches || []).length ? detail.batches.map(b => `<article class="card"><div class="material-meta"><span class="kind">${esc(b.code)}</span><span>${b.has_secret ? '비밀값 암호화 보관' : '비밀값 없음'}</span></div><h4 class="material-title">${esc(b.name)}</h4><p class="material-body">${esc(b.description)}</p><p class="source">실행 일정: ${esc(b.schedule || '미등록')}</p></article>`).join('') : '<div class="card muted">등록된 배치가 없습니다.</div>';
  renderAnalyses(); renderEvidence();
  $('#feature-map').textContent = JSON.stringify(detail.feature_map || {}, null, 2);
  if (tab === 'context') loadContext().catch(e => status(e.message, true));
}
function renderAnalyses() {
  $('#analyses').innerHTML = (detail.analyses || []).length ? detail.analyses.map(a => `<article class="card"><div class="material-meta"><span class="kind">${a.mode === 'risk' ? '리스크 검토' : '요구사항 검토'}</span><span>분석 #${a.id} · v${a.revision}</span></div><div class="material-head"><h4 class="material-title">${esc(a.request)}</h4><button class="text-button" data-edit-analysis="${a.id}">새 버전 작성</button></div><p class="material-body">${esc(a.result)}</p><p class="source">분석 출처: ${esc(a.source)} · ${esc(date(a.created_at))}</p><p class="source">참조 근거: ${evidenceLabel(a.evidence)}</p><details class="versions"><summary>분석 버전 ${a.versions.length}개 · 근거 스냅샷</summary>${a.versions.map(v => `<div class="version-line">v${v.revision} · ${esc(date(v.created_at))}<pre>${esc(JSON.stringify(v, null, 2))}</pre></div>`).join('')}</details></article>`).join('') : '<div class="card muted">아직 분석 이력이 없습니다. 분석 결과와 참조 근거를 함께 등록하세요.</div>';
}
function evidenceLabel(evidence = []) {
  return evidence.map(e => `#${e.material_id} v${e.revision}${e.title ? ' ' + esc(e.title) : ''}`).join(' · ') || '없음';
}
function renderEvidence() {
  const options = detail.materials.filter(m => approved(m)?.shared).map(m => ({...approved(m), material_id:m.id}));
  for (const ref of editingAnalysis?.evidence || []) {
    if (!options.some(o => o.material_id === ref.material_id && o.revision === ref.revision)) {
      const material = detail.materials.find(m => m.id === ref.material_id);
      const version = material?.versions.find(v => v.revision === ref.revision);
      if (version?.shared && version.status === 'approved') options.push({...version, material_id:ref.material_id});
    }
  }
  $('#analysis-evidence').innerHTML = options.length ? options.map(o => `<label class="check evidence-option"><input type="checkbox" name="evidence" value="${o.material_id}:${o.revision}" ${editingAnalysis?.evidence?.some(e => e.material_id === o.material_id && e.revision === o.revision) ? 'checked' : ''}><span>#${o.material_id} v${o.revision} · ${esc(o.title)}<small>${esc(o.source || '출처 없음')}</small></span></label>`).join('') : '<p class="help">먼저 근거 초안을 등록하고 승인해주세요.</p>';
}
function materialHint() {
  const kind = $('#material-form').elements.kind.value;
  const isFeature = kind === 'feature';
  $('#material-form').elements.body.placeholder = isFeature ? '{"summary":"주문 승인 중복 검토", "rules":["주문번호와 승인번호가 모두 같을 때 검토"], "related_ids":[]}' : kind === 'raw_data' ? '[{"order_id":"DEMO-101","amount":12000}]' : '판단 기준·업무 정책·설명을 입력하세요.';
  $('#material-hint').textContent = isFeature ? '기능 정의는 summary(설명), rules(규칙 배열), related_ids(같은 사이트의 관련 자료 ID 배열) 형식으로 입력하세요.' : kind === 'criterion' ? '예: 기존 기능 충족 여부 → 영향 범위 → 변경 리스크 → 최소 변경 대안 순서로 검토한다.' : kind === 'raw_data' ? '원데이터는 JSON 객체 또는 배열로 입력하세요.' : '이 자료의 적용 범위와 판단 근거를 구체적으로 기록하세요.';
}
function resetMaterial() {
  editing = null; $('#material-form').reset(); $('#material-form-title').textContent = '새 근거 초안 등록';
  $('#cancel-material').hidden = true; $('#material-form select').disabled = false; materialHint();
}
function resetAnalysis() {
  editingAnalysis = null; $('#analysis-form').reset(); $('#analysis-form-title').textContent = '분석 결과 등록';
  $('#cancel-analysis').hidden = true; if (detail) renderEvidence();
}
async function loadContext() { $('#context').textContent = JSON.stringify(await api(`/api/sites/${active}/context`), null, 2); }
function activateTab(name) {
  tab = name;
  for (const item of tabs) { $(`#panel-${item}`).hidden = item !== name; const b = $(`#tab-${item}`); b.classList.toggle('active', item === name); b.setAttribute('aria-selected', String(item === name)); }
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.dataset.site) { active = Number(button.dataset.site); editingAnalysis = null; resetMaterial(); $('#analysis-form').reset(); $('#analysis-form-title').textContent = '분석 결과 등록'; $('#cancel-analysis').hidden = true; $('#config-form').reset(); $('#batch-form').reset(); await refresh(); }
    if (button.dataset.tab) { activateTab(button.dataset.tab); if (tab === 'context') await loadContext(); }
    if (button.dataset.edit) {
      editing = detail.materials.find(m => m.id === Number(button.dataset.edit)); const form = $('#material-form');
      for (const name of ['kind','title','source','body']) form.elements[name].value = editing[name];
      form.elements.kind.disabled = true; $('#material-form-title').textContent = `새 초안 작성 · 현재 v${editing.revision}`; $('#cancel-material').hidden = false;
      materialHint(); form.scrollIntoView({behavior:'smooth', block:'start'});
    }
    if (button.dataset.review) { reviewing = detail.materials.find(m => m.id === Number(button.dataset.review)); $('#review-form').reset(); $('#review-target').textContent = `#${reviewing.id} ${reviewing.title} · v${reviewing.revision}`; $('#review-dialog').showModal(); }
    if (button.id === 'cancel-review') $('#review-dialog').close();
    if (button.id === 'new-material' || button.id === 'cancel-material') { resetMaterial(); $('#material-form').scrollIntoView({behavior:'smooth', block:'start'}); $('#material-form input[name=title]').focus(); }
    if (button.dataset.editAnalysis) {
      editingAnalysis = detail.analyses.find(a => a.id === Number(button.dataset.editAnalysis));
      for (const name of ['mode','request','result','source']) $('#analysis-form').elements[name].value = editingAnalysis[name];
      $('#analysis-form-title').textContent = `분석 새 버전 · 현재 v${editingAnalysis.revision}`; $('#cancel-analysis').hidden = false; renderEvidence(); $('#analysis-form').scrollIntoView({behavior:'smooth', block:'start'});
    }
    if (button.id === 'cancel-analysis') resetAnalysis();
    if (button.id === 'refresh-context') await loadContext();
    if (button.id === 'download-map') {
      const map = await api(`/api/sites/${active}/feature-map`); const url = URL.createObjectURL(new Blob([JSON.stringify(map, null, 2)], {type:'application/json'}));
      const link = document.createElement('a'); link.href = url; link.download = `${detail.site.slug}-feature-map.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (e) { status(e.message, true); }
});
$('#material-form select').addEventListener('change', materialHint);
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault(); const current = tabs.indexOf(tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  $(`#tab-${tabs[next]}`).click(); $(`#tab-${tabs[next]}`).focus();
});
async function submit(form, action) {
  const button = form.querySelector('button[type=submit],button.primary'); button.disabled = true;
  try { await action(); } catch (e) { status(e.message, true); } finally { button.disabled = false; }
}
$('#site-form').addEventListener('submit', event => { event.preventDefault(); submit(event.target, async () => {
  const result = await api('/api/sites','POST',Object.fromEntries(new FormData(event.target))); event.target.reset(); $('#new-site').open = false;
  editingAnalysis = null; resetMaterial(); $('#analysis-form').reset(); $('#analysis-form-title').textContent = '분석 결과 등록'; $('#cancel-analysis').hidden = true; $('#config-form').reset(); $('#batch-form').reset(); await refresh(result.id); status('사이트를 등록했습니다.');
}); });
$('#config-form').addEventListener('submit', event => { event.preventDefault(); submit(event.target, async () => {
  let config; try { config = JSON.parse(event.target.elements.config.value); } catch { throw new Error('설정 JSON 형식을 확인해주세요.'); }
  await api(`/api/sites/${active}/config`,'PUT',{base_revision:detail.config.revision,config}); event.target.reset(); await refresh(); status('설정을 암호화하여 새 버전으로 저장했습니다.');
}); });
$('#material-form').addEventListener('submit', event => { event.preventDefault(); submit(event.target, async () => {
  const form = event.target, data = Object.fromEntries(new FormData(form)); data.kind = form.elements.kind.value; data.shared = true;
  let path = `/api/sites/${active}/materials`, method = 'POST'; if (editing) { path += '/' + editing.id; method = 'PUT'; data.base_revision = editing.revision; }
  await api(path,method,data); resetMaterial(); await refresh(); status('초안을 저장했습니다. 검토·승인 후 기준자료로 제공됩니다.');
}); });
$('#review-form').addEventListener('submit', event => { event.preventDefault(); submit(event.target, async () => {
  const data = Object.fromEntries(new FormData(event.target)); data.revision = reviewing.revision;
  await api(`/api/sites/${active}/materials/${reviewing.id}/review`,'POST',data); $('#review-dialog').close(); await refresh(); status(data.decision === 'approved' ? `v${data.revision}을 승인했습니다.` : `v${data.revision}을 반려했습니다.`);
}); });
$('#batch-form').addEventListener('submit', event => { event.preventDefault(); submit(event.target, async () => {
  const data = Object.fromEntries(new FormData(event.target)); try { data.secrets = data.secrets.trim() ? JSON.parse(data.secrets) : {}; } catch { throw new Error('배치 비밀값 JSON 형식을 확인해주세요.'); }
  await api(`/api/sites/${active}/batches`,'POST',data); event.target.reset(); await refresh(); status('배치 정보를 저장했습니다. 비밀값은 반환하지 않습니다.');
}); });
$('#analysis-form').addEventListener('submit', event => { event.preventDefault(); submit(event.target, async () => {
  const form = event.target, data = Object.fromEntries(new FormData(form));
  data.evidence = new FormData(form).getAll('evidence').map(value => { const [material_id,revision] = value.split(':').map(Number); return {material_id,revision}; });
  let path = `/api/sites/${active}/analyses`, method = 'POST'; if (editingAnalysis) { path += '/' + editingAnalysis.id; method = 'PUT'; data.base_revision = editingAnalysis.revision; }
  await api(path,method,data); resetAnalysis(); await refresh(); status('분석 결과와 참조 근거 버전을 기록했습니다.');
}); });
materialHint(); refresh().catch(e => status(e.message, true));
