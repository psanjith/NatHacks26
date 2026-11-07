/* Local communication prototype. No EEG decoder, notifications, or robot commands. */
(() => {
  'use strict';
  const { needs, active, createRequest, transition, parseStore } = CareModel;
  const KEY = 'reach-care-requests-v1';
  const $ = id => document.getElementById(id);
  let store = { version: 1, requests: [] };
  let storageOK = true;
  let selected = null;
  let detail = '';
  let view = 'patient';
  let withdrawing = false;
  let sentId = null;
  const labels = { waiting: 'Waiting for a response', seen: 'Your request has been seen', coming: 'Your caregiver is on the way', done: 'Marked as handled', withdrawn: 'Request withdrawn' };
  const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const time = timestamp => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
  function announce(message) { $('announcer').textContent = message; }
  function load() {
    if (!storageOK) return;
    try { store = parseStore(localStorage.getItem(KEY)); }
    catch { storageOK = false; notice('Browser storage is unavailable. This demo will only remember requests until you close or refresh this page.'); }
  }
  function save() {
    if (!storageOK) return;
    try { localStorage.setItem(KEY, JSON.stringify(store)); }
    catch { storageOK = false; notice('This request is only held in this open page. Browser storage is unavailable.'); }
  }
  function current() { return store.requests.find(active) || store.requests.find(r => r.id === sentId) || store.requests[0] || null; }
  function preview(request) {
    return `<div class="message-preview"><p class="eyebrow">YOUR MESSAGE</p><p class="message-text">${esc(request.message)}</p>${request.detail ? `<p class="detail-text">${esc(request.detail)}</p>` : ''}</div>`;
  }
  function cards() {
    const busy = store.requests.some(active);
    $('need-cards').innerHTML = needs.filter(n => n.id !== 'arm').map(n => `<button class="need-card" data-need="${n.id}" aria-pressed="${selected === n.id}" ${busy ? 'disabled' : ''}><span class="icon-box">${icon(n.icon)}</span><span class="need-title">${n.title}</span><span class="need-category">${n.short}</span><svg class="card-arrow" aria-hidden="true"><use href="#i-arrow"></use></svg></button>`).join('');
    $('object-help-button').disabled = busy;
    $('object-help-button').setAttribute('aria-pressed', String(selected === 'arm'));
  }
  function timeline(r) {
    const steps = [['waiting', 'Request added'], ['seen', 'Seen by caregiver'], ['coming', 'Caregiver on the way'], ['done', 'Marked as handled']];
    if (r.status === 'withdrawn') steps.splice(1, 3, ['withdrawn', 'Withdrawn by you']);
    return `<ol class="timeline">${steps.map(([status, label]) => {
      const event = r.events.find(e => e.status === status);
      return `<li class="${event ? 'reached' : ''}"><span>${label}${event ? `<time datetime="${new Date(event.at).toISOString()}">${time(event.at)}</time>` : ''}</span></li>`;
    }).join('')}</ol>`;
  }
  function patientPanel() {
    const request = current();
    if (selected && !store.requests.some(active)) {
      const need = needs.find(n => n.id === selected);
      $('panel-badge').textContent = 'Review before adding';
      $('request-content').innerHTML = `<div class="request-body"><h2 id="request-panel-title" tabindex="-1">Does this say what you need?</h2><p class="request-subtitle">You can add a detail, or keep it simple.</p>${preview({ message: need.message, detail })}<span class="details-title" id="details-title">Add a detail <span>(optional)</span></span><div class="detail-options" role="group" aria-labelledby="details-title">${need.details.map(d => `<button class="detail-option" data-detail="${esc(d)}" aria-pressed="${d === detail}">${esc(d)}</button>`).join('')}</div><div class="actions stacked"><button class="primary" data-action="submit">Add request to demo inbox ${icon('arrow')}</button><button class="quiet" data-action="cancel-selection">Choose something else</button></div><p class="microcopy">Only the caregiver demo view in this browser receives this request.</p></div>`;
      return;
    }
    if (request) {
      $('panel-badge').textContent = active(request) ? 'Local demo request' : 'Request closed';
      const descriptions = { waiting: 'No caregiver response yet. Open Caregiver view to try a response.', seen: 'Someone has marked this request as seen in the demo.', coming: 'The caregiver demo has responded: “I’m on my way.”', done: 'The caregiver demo marked this request as handled. You can ask again if you still need help.', withdrawn: 'This request is closed. You can choose a different need.' };
      $('request-content').innerHTML = `<div class="request-body"><div class="status-title"><span class="status-icon">${icon(active(request) ? 'company' : 'check')}</span><h2 id="request-panel-title" tabindex="-1">${labels[request.status]}</h2></div><p class="request-subtitle">${descriptions[request.status]}</p>${preview(request)}${timeline(request)}${active(request) ? (withdrawing ? `<p>Withdraw this request?</p><div class="actions"><button class="secondary" data-action="withdraw" data-id="${esc(request.id)}">Yes, withdraw</button><button class="primary" data-action="keep">Keep request</button></div>` : `<div class="actions"><button class="secondary" data-action="ask-withdraw">Withdraw request</button><button class="quiet" data-action="show-caregiver">Try caregiver view</button></div>`) : '<p class="microcopy">Choose a card to create another request.</p>'}</div>`;
      return;
    }
    $('panel-badge').textContent = 'Ready when you are';
    $('request-content').innerHTML = `<div class="empty-state"><div class="empty-art">${icon('company')}</div><h2 id="request-panel-title">A simple way to be heard.</h2><p>Choose a card to prepare a message.<br>Nothing is added until you confirm.</p><p class="empty-caption">Your request and the caregiver’s response<br>will appear here.</p></div>`;
  }
  function history(target) {
    const requests = store.requests.filter(r => !active(r));
    $(target).innerHTML = requests.length ? requests.slice(0, 6).map(r => `<div class="history-row"><div><strong>${esc(r.title)}</strong><p>${esc(r.detail || r.message)}</p></div><div class="history-status">${labels[r.status]}<time datetime="${new Date(r.updatedAt).toISOString()}">${time(r.updatedAt)}</time></div></div>`).join('') : '<p class="microcopy">Completed and withdrawn requests will appear here.</p>';
    $('patient-history-section').hidden = !requests.length;
  }
  function caregiver() {
    const pending = store.requests.filter(active);
    $('queue-label').textContent = `${pending.length} ACTIVE REQUEST${pending.length === 1 ? '' : 'S'}`;
    $('caregiver-inbox').innerHTML = pending.length ? pending.map(r => `<article class="care-card"><h3>${esc(r.title)}</h3><p>${labels[r.status]} · ${time(r.createdAt)}</p>${preview(r)}<div class="actions">${r.status === 'waiting' ? `<button class="primary" data-status="seen" data-id="${esc(r.id)}">I've seen this ${icon('check')}</button>` : ''}${r.status === 'seen' ? `<button class="primary" data-status="coming" data-id="${esc(r.id)}">I'm on my way ${icon('arrow')}</button>` : ''}${['seen', 'coming'].includes(r.status) ? `<button class="${r.status === 'coming' ? 'primary' : 'secondary'}" data-status="done" data-id="${esc(r.id)}">Mark as handled</button>` : ''}</div><p class="microcopy">Demo response · visible in My requests on this browser.</p></article>`).join('') : `<div class="empty-state"><div class="empty-art">${icon('check')}</div><h2>All quiet for now.</h2><p>Requests will appear here after someone<br>chooses and confirms a need.</p><div class="actions"><button class="secondary" data-action="show-patient">Try creating a request</button></div></div>`;
    $('inbox-count').hidden = !pending.length;
    $('inbox-count').textContent = pending.length;
  }
  function render() {
    cards(); patientPanel(); caregiver(); history('patient-history'); history('caregiver-history');
    $('patient-view').hidden = view !== 'patient';
    $('caregiver-view').hidden = view !== 'caregiver';
    $('patient-view-button').setAttribute('aria-pressed', String(view === 'patient'));
    $('caregiver-view-button').setAttribute('aria-pressed', String(view === 'caregiver'));
  }
  function selectNeed(id) {
    load();
    if (store.requests.some(active)) { announce('There is already an active request. Withdraw it before choosing another.'); return false; }
    if (!needs.some(n => n.id === id)) return false;
    selected = id; detail = ''; withdrawing = false; view = 'patient'; render();
    $('request-panel-title').focus({ preventScroll: true });
    if (matchMedia('(max-width:760px)').matches) $('request-panel-title').scrollIntoView({ block: 'center', behavior: 'auto' });
    announce('Review your message before adding it to the demo inbox.'); return true;
  }
  function submit() {
    load();
    if (!selected || store.requests.some(active)) { selected = null; render(); return; }
    const now = Date.now();
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `request-${now}-${Math.random().toString(36).slice(2)}`;
    const request = createRequest(selected, detail, now, id);
    store.requests.unshift(request); store.requests = store.requests.slice(0, 20);
    sentId = id; selected = null; detail = ''; save(); render();
    $('request-panel-title').focus({ preventScroll: true }); announce('Request added locally. No real caregiver has been notified.');
  }
  function updateStatus(id, status) {
    load();
    const index = store.requests.findIndex(r => r.id === id);
    try {
      store.requests[index] = transition(store.requests[index], status, Date.now());
      withdrawing = false; save(); render(); announce(labels[status]);
      if (view === 'patient') $('request-panel-title').focus({ preventScroll: true });
      else { const next = $('caregiver-inbox').querySelector('button'); if (next) next.focus({ preventScroll: true }); }
    } catch (error) { notice(error.message); render(); }
  }
  function switchView(next) { view = next; load(); render(); announce(next === 'patient' ? 'My requests view.' : 'Caregiver demo view.'); }
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.need) return selectNeed(button.dataset.need);
    if (button.dataset.detail) {
      detail = detail === button.dataset.detail ? '' : button.dataset.detail;
      const previous = button.dataset.detail;
      patientPanel();
      [...$('request-content').querySelectorAll('[data-detail]')].find(b => b.dataset.detail === previous)?.focus({ preventScroll: true });
      return;
    }
    if (button.dataset.status) return updateStatus(button.dataset.id, button.dataset.status);
    switch (button.dataset.action) {
      case 'submit': submit(); break;
      case 'cancel-selection': selected = null; detail = ''; render(); $('need-cards').querySelector('button').focus({ preventScroll: true }); break;
      case 'ask-withdraw': withdrawing = true; patientPanel(); $('request-content').querySelector('[data-action="keep"]').focus({ preventScroll: true }); break;
      case 'keep': withdrawing = false; patientPanel(); $('request-content').querySelector('[data-action="ask-withdraw"]').focus({ preventScroll: true }); break;
      case 'withdraw': updateStatus(button.dataset.id, 'withdrawn'); break;
      case 'show-caregiver': switchView('caregiver'); $('caregiver-view-button').focus(); break;
      case 'show-patient': switchView('patient'); $('patient-view-button').focus(); break;
    }
  });
  $('patient-view-button').addEventListener('click', () => switchView('patient'));
  $('caregiver-view-button').addEventListener('click', () => switchView('caregiver'));
  $('text-size-button').addEventListener('click', () => {
    const large = document.documentElement.classList.toggle('large-text');
    $('text-size-button').setAttribute('aria-pressed', String(large));
    $('text-size-button').setAttribute('aria-label', large ? 'Use standard text size' : 'Use larger text');
    try { localStorage.setItem('reach-care-large-text', String(large)); } catch { /* preference is optional */ }
  });
  window.addEventListener('storage', event => {
    if (event.key !== KEY && event.key !== null) return;
    load(); if (store.requests.some(active)) selected = null;
    render(); announce(current() ? labels[current().status] : 'Requests updated.');
  });
  // A future input adapter may select an intent, but selection never submits it.
  window.ReachCare = Object.freeze({ selectNeed, getNeeds: () => needs.map(({ id, title }) => ({ id, title })) });
  load();
  try { if (localStorage.getItem('reach-care-large-text') === 'true') $('text-size-button').click(); } catch { /* optional */ }
  render();
})();
