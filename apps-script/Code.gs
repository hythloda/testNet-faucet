const FAUCET = Object.freeze({
  board: '18438203163', group: 'topics', qaGroup: 'group_mm8rkc2b',
  origin: 'https://testnet-faucet.canton.foundation',
  owner: 'amanda@canton.foundation', version: 'monday-2026-11-02',
  columns: {
    party: 'text_mm8rjpkq', amount: 'numeric_mm8rbnwm', usage: 'long_text_mm8rj7bj',
    contact: 'text_mm8rgmsj', status: 'color_mm8r8qk2', created: 'date_mm8rpa1q',
    modified: 'date_mm8rvwat', hours: 'numeric_mm8rc5vg', legacyId: 'text_mm8rk2b2',
    requestId: 'text_mm8rtpnw', source: 'text_mm8r4ar5', notification: 'color_mm8r8se0'
  }
});

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ service: 'canton-testnet-faucet', backend: 'monday', version: FAUCET.version }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let requestId = String(e && e.parameter && e.parameter.request_id || '').slice(0, 100);
  try {
    const request = parseFaucetInput_(e && e.parameter || {});
    requestId = request.requestId;
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) throw faucetInputError_('The service is busy. Please try again.');
    try { saveFaucetRequest_(request); } finally { lock.releaseLock(); }
    return faucetReply_({ success: true, requestId: requestId, message: 'Your request has been saved.' });
  } catch (error) {
    console.error('Faucet submission failed: ' + (error.publicMessage || error.message));
    return faucetReply_({ success: false, requestId: requestId, message: error.publicMessage || 'We could not save your request. Please try again.' });
  }
}

function parseFaucetInput_(p) {
  if (String(p.website || '').trim()) throw faucetInputError_('Unable to accept this submission.');
  const rawAmount = String(p['CC Amount'] || '').trim();
  const amount = Number(rawAmount);
  if (!/^\d+$/.test(rawAmount) || !Number.isSafeInteger(amount) || amount < 1) throw faucetInputError_('Enter a positive whole number of CC.');
  const party = String(p.PartyID || '').trim();
  if (!party || party.length > 512 || /[\x00-\x1f\x7f]/.test(party)) throw faucetInputError_('Enter a valid PartyID.');
  const usage = String(p.Usage || '').trim();
  if (usage.length > 10000) throw faucetInputError_('Keep Usage under 10,000 characters.');
  if (amount > 1000 && !usage) throw faucetInputError_('Please explain requests over 1000 CC in Usage.');
  const contact = String(p.Contact || '').trim();
  if (contact.length > 512) throw faucetInputError_('Keep Contact under 512 characters.');
  const requestId = String(p.request_id || Utilities.getUuid()).trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)) throw faucetInputError_('Invalid submission ID. Please reload the form.');
  return { amount: amount, party: party, usage: usage, contact: contact, requestId: requestId };
}

function saveFaucetRequest_(request) {
  const c = FAUCET.columns;
  const found = faucetMonday_('query($b:ID!,$c:String!,$id:String!,$cols:[String!]!){items_page_by_column_values(board_id:$b,limit:1,columns:[{column_id:$c,column_values:[$id]}]){items{id column_values(ids:$cols){id text value}}}}',
    { b: FAUCET.board, c: c.requestId, id: request.requestId, cols: [c.party, c.amount, c.usage, c.contact] });
  const existing = found.items_page_by_column_values.items[0];
  if (existing) {
    const cells = Object.fromEntries(existing.column_values.map(function (v) { return [v.id, v]; }));
    if (faucetCell_(cells[c.party]) !== request.party || Number(faucetCell_(cells[c.amount])) !== request.amount ||
        faucetCell_(cells[c.usage]) !== request.usage || faucetCell_(cells[c.contact]) !== request.contact) {
      throw faucetInputError_('This submission was already saved with different details. Reload the form to start a new request.');
    }
    return existing.id;
  }

  const properties = PropertiesService.getScriptProperties();
  const qa = properties.getProperty('FAUCET_QA_ID') === request.requestId && Number(properties.getProperty('FAUCET_QA_EXPIRES')) > Date.now();
  const now = new Date();
  const values = {};
  values[c.party] = request.party;
  values[c.amount] = String(request.amount);
  values[c.usage] = { text: request.usage };
  values[c.contact] = request.contact;
  values[c.status] = { label: qa ? 'Ignoring' : 'New' };
  values[c.created] = faucetDate_(now);
  values[c.modified] = faucetDate_(now);
  values[c.hours] = '0';
  values[c.requestId] = request.requestId;
  values[c.source] = qa ? 'Validation' : 'Website';
  values[c.notification] = { label: qa ? 'Suppressed' : 'Pending' };
  const result = faucetMonday_('mutation($b:ID!,$g:String!,$name:String!,$values:JSON!){create_item(board_id:$b,group_id:$g,item_name:$name,column_values:$values){id}}',
    { b: FAUCET.board, g: qa ? FAUCET.qaGroup : FAUCET.group, name: request.party.slice(0, 255), values: JSON.stringify(values) });
  const id = result.create_item && result.create_item.id;
  if (!id) throw new Error('Monday did not confirm the saved request.');
  if (qa) {
    properties.deleteProperty('FAUCET_QA_ID'); properties.deleteProperty('FAUCET_QA_EXPIRES');
  } else {
    properties.setProperty('faucet-status:' + id, 'New');
    notifyFaucet_(id, request);
  }
  return id;
}

function notifyFaucet_(id, request) {
  const properties = PropertiesService.getScriptProperties();
  const receipt = 'faucet-mail:' + id;
  try {
    if (!properties.getProperty(receipt)) {
      MailApp.sendEmail({ to: FAUCET.owner, subject: 'TestNet Faucet Response', name: 'Canton TestNet Faucet',
        body: 'PartyID: ' + request.party + '\n\nAmount: ' + request.amount + ' CC\n\nUsage: ' + request.usage +
          '\n\nContact: ' + request.contact + '\n\nRequest in Monday: https://canton-foundation.monday.com/boards/' + FAUCET.board + '/pulses/' + id });
      properties.setProperty(receipt, 'sent');
    }
    faucetUpdate_(id, { [FAUCET.columns.notification]: { label: 'Sent' } });
    properties.deleteProperty(receipt);
  } catch (error) {
    console.error('Faucet notification needs retry for item ' + id + ': ' + error.message);
    try { faucetUpdate_(id, { [FAUCET.columns.notification]: { label: 'Failed' } }); } catch (ignored) { console.error('Notification state update failed for item ' + id); }
  }
}

// Private handler: callable by the installed trigger, not google.script.run clients.
function retryFaucetNotifications_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const c = FAUCET.columns;
    let cursor = null;
    do {
      const data = faucetMonday_('query($b:[ID!]!,$cursor:String,$cols:[String!]!){boards(ids:$b){items_page(limit:500,cursor:$cursor){cursor items{id updated_at column_values(ids:$cols){id text value}}}}}',
        { b: [FAUCET.board], cursor: cursor, cols: Object.values(c) });
      if (!data.boards[0]) throw new Error('The faucet board is unavailable.');
      const page = data.boards[0].items_page;
      for (const item of page.items) {
        const cells = Object.fromEntries(item.column_values.map(function (v) { return [v.id, v]; }));
        if (faucetCell_(cells[c.source]) !== 'Website') continue;
        const state = faucetCell_(cells[c.status]);
        const previous = PropertiesService.getScriptProperties().getProperty('faucet-status:' + item.id) || 'New';
        if (state !== previous) {
          const start = JSON.parse(cells[c.created].value);
          const requested = new Date(start.date + 'T' + (start.time || '00:00:00') + 'Z');
          const changed = new Date(item.updated_at);
          faucetUpdate_(item.id, { [c.modified]: faucetDate_(changed), [c.hours]: String(Math.max(0, Math.floor((changed - requested) / 3600000))) });
          PropertiesService.getScriptProperties().setProperty('faucet-status:' + item.id, state);
        }
        if (['Pending', 'Failed'].includes(faucetCell_(cells[c.notification]))) {
          notifyFaucet_(item.id, { party: faucetCell_(cells[c.party]), amount: faucetCell_(cells[c.amount]), usage: faucetCell_(cells[c.usage]), contact: faucetCell_(cells[c.contact]) });
        }
      }
      cursor = page.cursor || null;
    } while (cursor);
  } finally { lock.releaseLock(); }
}

function verifyFaucetSetup() {
  faucetAdmin_();
  const data = faucetMonday_('query($b:[ID!]!){boards(ids:$b){id name groups{id} columns{id}}}', { b: [FAUCET.board] });
  const board = data.boards && data.boards[0];
  if (!board || String(board.id) !== FAUCET.board) throw new Error('The Monday token cannot access the TestNet Faucet Requests board.');
  const ids = board.columns.map(function (column) { return column.id; });
  for (const id of Object.values(FAUCET.columns)) if (!ids.includes(id)) throw new Error('Missing Monday column: ' + id);
  for (const id of [FAUCET.group, FAUCET.qaGroup]) if (!board.groups.some(function (group) { return group.id === id; })) throw new Error('Missing Monday request group.');
  Logger.log(JSON.stringify({ ready: true, board: board.name, boardId: board.id, backend: 'monday' }));
  return true;
}

function installFaucetAutomation() {
  faucetAdmin_(); verifyFaucetSetup();
  const exists = ScriptApp.getProjectTriggers().some(function (trigger) { return trigger.getHandlerFunction() === 'retryFaucetNotifications_'; });
  if (!exists) ScriptApp.newTrigger('retryFaucetNotifications_').timeBased().everyMinutes(15).create();
  Logger.log('Faucet notification retries and status timing are installed (every 15 minutes).');
}

function prepareFaucetWebTest() {
  faucetAdmin_(); verifyFaucetSetup();
  const id = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperties({ FAUCET_QA_ID: id, FAUCET_QA_EXPIRES: String(Date.now() + 600000) });
  Logger.log('One-use website test, notification suppressed: ' + FAUCET.origin + '/?request_id=' + id);
  return id;
}

function faucetAdmin_() {
  if (Session.getActiveUser().getEmail().toLowerCase() !== FAUCET.owner) throw new Error('This function must be run by the faucet administrator from the Apps Script editor.');
}

function faucetMonday_(query, variables) {
  const token = PropertiesService.getScriptProperties().getProperty('MONDAY_API_TOKEN');
  if (!token) throw new Error('MONDAY_API_TOKEN is missing from Script Properties.');
  const response = UrlFetchApp.fetch('https://api.monday.com/v2', { method: 'post', contentType: 'application/json',
    headers: { Authorization: token.trim(), 'API-Version': '2026-04' }, payload: JSON.stringify({ query: query, variables: variables }), muteHttpExceptions: true });
  const data = JSON.parse(response.getContentText());
  if (response.getResponseCode() >= 300 || data.errors || data.error_code || !data.data) throw new Error('The Monday API request failed. Check the script execution details and token access.');
  return data.data;
}

function faucetUpdate_(id, values) {
  faucetMonday_('mutation($b:ID!,$id:ID!,$v:JSON!){change_multiple_column_values(board_id:$b,item_id:$id,column_values:$v){id}}',
    { b: FAUCET.board, id: String(id), v: JSON.stringify(values) });
}

function faucetCell_(cell) {
  if (!cell) return '';
  if (cell.type === 'long_text' || (!cell.text && cell.value)) {
    try { const value = JSON.parse(cell.value); if (value && typeof value.text === 'string') return value.text; } catch (ignored) { /* use display text */ }
  }
  return cell.text || '';
}

function faucetDate_(value) {
  const iso = new Date(value).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

function faucetInputError_(message) {
  const error = new Error(message); error.publicMessage = message; return error;
}

function faucetReply_(result) {
  result.type = 'canton-faucet-result';
  const json = JSON.stringify(result).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = '<!doctype html><html><body><p>Request processed. You may return to the faucet form.</p><script>window.top.postMessage(' + json + ',' + JSON.stringify(FAUCET.origin) + ');</script></body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
