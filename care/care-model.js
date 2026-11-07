(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.CareModel = model;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const needs = [
    { id: 'position', title: 'Help me get comfortable', short: 'Position & comfort', icon: 'position', message: 'Please help me adjust my position.', details: ['Adjust my pillow', 'Help me change position', 'Check my blanket'] },
    { id: 'discomfort', title: 'Something feels wrong', short: 'Discomfort', icon: 'comfort', message: 'I am uncomfortable. Please come and check on me.', details: ['I feel too warm', 'I feel too cold', 'I am in pain'] },
    { id: 'device', title: 'Help with my device', short: 'My device', icon: 'device', message: 'Please help me with my device.', details: ['Adjust my screen', 'My device is not working', 'Help me charge it'] },
    { id: 'company', title: 'Please come here', short: 'Connection', icon: 'company', message: 'Please come here. I would like your company.', details: ['I want to talk', 'Please stay with me', 'I need help explaining something'] },
    { id: 'arm', title: 'Help with an object', short: 'Object assistance', icon: 'position', message: 'Please help me with the object I need.', details: ['The arm could not reach it', 'The grasp did not work', 'I need help using it'] }
  ];
  const active = request => !!request && ['waiting', 'seen', 'coming'].includes(request.status);
  function createRequest(needId, detail, now, id) {
    const need = needs.find(n => n.id === needId);
    if (!need || (detail && !need.details.includes(detail))) throw new Error('Choose a valid need.');
    return { id, needId, title: need.short, message: need.message, detail: detail || '', status: 'waiting', createdAt: now, updatedAt: now, events: [{ status: 'waiting', at: now }] };
  }
  const transitions = { waiting: ['seen', 'withdrawn'], seen: ['coming', 'done', 'withdrawn'], coming: ['done', 'withdrawn'], done: [], withdrawn: [] };
  function transition(request, next, now) {
    if (!request || !transitions[request.status]?.includes(next)) throw new Error('This request has changed. Please check its current status.');
    return { ...request, status: next, updatedAt: now, events: [...request.events, { status: next, at: now }] };
  }
  function validRequest(r) {
    const need = needs.find(n => n.id === r?.needId);
    return !!need && typeof r.id === 'string' && r.id.length < 100 && r.title === need.short && r.message === need.message && (r.detail === '' || need.details.includes(r.detail)) && Object.hasOwn(transitions, r.status) && Number.isFinite(r.createdAt) && Number.isFinite(r.updatedAt) && Array.isArray(r.events) && r.events.length > 0 && r.events.length < 10 && r.events.every(e => e && Object.hasOwn(transitions, e.status) && Number.isFinite(e.at));
  }
  function parseStore(raw) {
    try {
      const value = JSON.parse(raw);
      if (value?.version !== 1 || !Array.isArray(value.requests)) return { version: 1, requests: [] };
      return { version: 1, requests: value.requests.filter(validRequest).slice(0, 20) };
    } catch { return { version: 1, requests: [] }; }
  }
  return { needs, active, createRequest, transition, parseStore };
});
