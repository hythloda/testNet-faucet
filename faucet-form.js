(function () {
  'use strict';
  const form = document.getElementById('testnet-faucet-form');
  const amount = document.getElementById('cc_amount');
  const usage = document.getElementById('usage');
  const warning = document.getElementById('cc-warning');
  const button = document.getElementById('submit-request');
  const error = document.getElementById('submit-error');
  const requestId = document.getElementById('request-id');
  const qaId = new URLSearchParams(window.location.search).get('request_id');
  requestId.value = qaId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(qaId) ? qaId : window.crypto.randomUUID();
  let pending = false;
  let timer;

  function updateUsageRequirement() {
    const needsJustification = Number(amount.value || 0) > 1000;
    usage.required = needsJustification;
    warning.style.display = needsJustification ? 'block' : 'none';
  }

  function showError(message) {
    pending = false;
    window.clearTimeout(timer);
    button.disabled = false;
    button.textContent = 'Submit Request';
    form.removeAttribute('aria-busy');
    error.textContent = message;
    error.hidden = false;
  }

  function trustedOrigin(origin) {
    try {
      const url = new URL(origin);
      return url.protocol === 'https:' && (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com' ||
        url.hostname.endsWith('.script.googleusercontent.com') || url.hostname.endsWith('-script.googleusercontent.com'));
    } catch (_) { return false; }
  }

  amount.addEventListener('input', updateUsageRequirement);
  updateUsageRequirement();
  form.addEventListener('submit', function (event) {
    updateUsageRequirement();
    if (pending || !form.checkValidity()) { event.preventDefault(); return; }
    pending = true;
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Submitting…';
    form.setAttribute('aria-busy', 'true');
    timer = window.setTimeout(function () {
      showError('We could not confirm your submission. Please try again; your details have been kept.');
    }, 45000);
  });

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (!pending || !trustedOrigin(event.origin) || !data || data.type !== 'canton-faucet-result' || data.requestId !== requestId.value) return;
    if (data.success !== true) { showError(data.message || 'We could not save your request. Please try again.'); return; }
    pending = false;
    window.clearTimeout(timer);
    form.removeAttribute('aria-busy');
    document.getElementById('form-shell').style.display = 'none';
    document.getElementById('thank-you-message').style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
