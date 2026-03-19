/**
 * popup.js — NetSuite Script Finder
 * Orchestrates messaging, rendering, filtering, and toggle interactions.
 */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
let STATE = {
  recordInfo:    null,
  baseUrl:       null,
  grouped:       {},   // { [scriptType]: { label, color, scripts[] } }
  showInactive:  false,
  activeFilter:  'all',
  searchQuery:   '',
  totalScripts:  0,
  activeTab:     'scripts', // 'scripts' | 'field-search'
};

// ─── DOM References ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  recordBadge:      $('record-badge'),
  recordTypeLabel:  $('record-type-label'),
  accountTag:       $('account-tag'),
  searchInput:      $('search-input'),
  filterBar:        $('filter-bar'),
  content:          $('content'),
  loadingState:     $('loading-state'),
  emptyState:       $('empty-state'),
  errorState:       $('error-state'),
  nonNsState:       $('non-ns-state'),
  noRecordState:    $('no-record-state'),
  scriptsContainer: $('scripts-container'),
  footerBar:        $('footer-bar'),
  visibleCount:     $('visible-count'),
  totalCountLabel:  $('total-count-label'),
  showInactiveToggle: $('show-inactive-toggle'),
  btnRetry:         $('btn-retry'),
  toast:            $('toast'),
};

// ─── Human-readable record type names ────────────────────────────────────────
const RECORD_LABELS = {
  salesorder:         'Sales Order',
  purchaseorder:      'Purchase Order',
  invoice:            'Invoice',
  creditmemo:         'Credit Memo',
  customerpayment:    'Customer Payment',
  estimate:           'Estimate / Quote',
  opportunity:        'Opportunity',
  supportcase:        'Support Case',
  returnauthorization:'Return Authorization',
  vendorauthorization:'Vendor Authorization',
  vendorpayment:      'Vendor Payment',
  vendorcredit:       'Vendor Credit',
  journalentry:       'Journal Entry',
  transfer:           'Transfer',
  inventorytransfer:  'Inventory Transfer',
  itemreceipt:        'Item Receipt',
  itemfulfillment:    'Item Fulfillment',
  cashsale:           'Cash Sale',
  cashrefund:         'Cash Refund',
  assemblybuild:      'Assembly Build',
  assemblyunbuild:    'Assembly Unbuild',
  workorder:          'Work Order',
  customer:           'Customer',
  employee:           'Employee',
  vendor:             'Vendor',
  partner:            'Partner',
  contact:            'Contact',
  lead:               'Lead',
  prospect:           'Prospect',
  item:               'Item',
  inventoryitem:      'Inventory Item',
  serviceitem:        'Service Item',
  noninventoryitem:   'Non-Inventory Item',
  assemblyitem:       'Assembly Item',
  kititem:            'Kit / Package',
  campaign:           'Campaign',
  task:               'Task',
  phonecall:          'Phone Call',
  calendarevent:      'Calendar Event',
  account:            'Account',
  department:         'Department',
  classification:     'Class',
  location:           'Location',
  // Additional transactions
  customerdeposit:    'Customer Deposit',
  customerrefund:     'Customer Refund',
  check:              'Check',
  deposit:            'Deposit',
  expensereport:      'Expense Report',
  intercompanyjournalentry:    'Intercompany Journal',
  advintercompanyjournalentry: 'Advanced IC Journal',
  inventoryadjustment:         'Inventory Adjustment',
  physicalinventoryworksheet:  'Inventory Count',
  purchasecontract:   'Purchase Contract',
  blanketpurchaseorder:'Blanket Purchase Order',
  workorderclose:     'Work Order Close',
  workordercompletion:'Work Order Completion',
  // Payroll
  paycheckjournal:    'Paycheck Journal',
  paycheck:           'Paycheck',
  // Time & Projects
  timebill:           'Time Entry',
  timesheet:          'Timesheet',
  job:                'Project / Job',
  projecttask:        'Project Task',
  projecttemplate:    'Project Template',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function recordLabel(type) {
  return RECORD_LABELS[type] || type
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

function showOnly(stateKey) {
  const all = ['loadingState','emptyState','errorState','nonNsState','noRecordState','scriptsContainer'];
  all.forEach(k => {
    if (els[k]) els[k].style.display = 'none';
  });
  if (els[stateKey]) els[stateKey].style.display = '';
  els.footerBar.style.display = (stateKey === 'scriptsContainer') ? '' : 'none';
}

function showToast(message, type = 'info', duration = 3000) {
  const t = els.toast;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  t.textContent = '';
  const icon = document.createElement('span');
  icon.textContent = icons[type] || '';
  const msg = document.createElement('span');
  msg.textContent = message;
  t.appendChild(icon);
  t.appendChild(msg);
  t.className = `show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, duration);
}

function getBaseUrl(accountId) {
  // Try to build the correct subdomain URL
  if (accountId) {
    // Normalize: replace underscores with hyphens for subdomain
    const subdomain = accountId.toLowerCase().replace(/_/g, '-');
    return `https://${subdomain}.app.netsuite.com`;
  }
  // Fallback: use current tab origin
  return null;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusPill(script) {
  if (script.isInactive || !script.isDeployed) {
    return `<span class="status-pill inactive">Inactive</span>`;
  }
  if (script.status === 'TESTING') {
    return `<span class="status-pill testing">Testing</span>`;
  }
  return `<span class="status-pill deployed">Deployed</span>`;
}

function versionChip(apiVersion) {
  const v = String(apiVersion);
  const cls = v.startsWith('2.1') ? 'v21' : v.startsWith('2') ? 'v20' : v.startsWith('1') ? 'v10' : '';
  return `<span class="version-chip ${cls}">v${escHtml(v)}</span>`;
}

// Entry point display order per script type
const EP_ORDER = {
  userevent:   ['beforeLoad', 'beforeSubmit', 'afterSubmit'],
  clientscript: ['pageInit', 'fieldChanged', 'saveRecord', 'validateField', 'sublistChanged', 'validateLine', 'validateInsert'],
};

function renderCard(script, categoryColor) {
  const scriptUrl = STATE.baseUrl
    ? `${STATE.baseUrl}/app/common/scripting/script.nl?id=${encodeURIComponent(script.scriptId)}`
    : '';
  const desc = script.description
    ? escHtml(script.description.substring(0, 120)) + (script.description.length > 120 ? '…' : '')
    : '';

  const meta = [script.scriptScriptId, script.ownerName]
    .filter(Boolean).map(escHtml).join(' · ');

  const epOrder = EP_ORDER[script.scriptType] || [];
  const eps = (script.entryPoints || [])
    .slice()
    .sort((a, b) => {
      const ai = epOrder.indexOf(a), bi = epOrder.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

  const epChips = eps.map(ep => `<span class="ep-chip">${escHtml(ep)}</span>`).join('');

  return `
    <div class="script-card"
         data-type="${escHtml(script.scriptType)}"
         data-name="${escHtml(script.name.toLowerCase())}"
         data-scriptid="${escHtml((script.scriptScriptId || '').toLowerCase())}"
         data-script-url="${escHtml(scriptUrl)}"
         style="--card-accent: ${escHtml(categoryColor)}">
      <div class="card-body">
        <div class="card-top">
          <div class="script-name">${script.isLocked ? '<span class="lock-icon" title="Source locked / bundle-protected">🔒</span>' : ''}${escHtml(script.name)}</div>
          <div class="card-badges">
            ${statusPill(script)}
            ${script.apiVersion ? versionChip(script.apiVersion) : ''}
          </div>
        </div>
        ${epChips ? `<div class="card-eps">${epChips}</div>` : ''}
        ${meta ? `<div class="card-meta">${meta}</div>` : ''}
        ${desc ? `<div class="card-desc">${desc}</div>` : ''}
      </div>
    </div>
  `;
}

function renderGroups(grouped) {
  const container = els.scriptsContainer;
  container.innerHTML = '';

  let totalVisible = 0;

  // Determine order of categories
  const categoryOrder = [
    'clientscript', 'userevent', 'workflowaction', 'massupdate',
  ];

  const allTypes = [
    ...categoryOrder.filter(t => grouped[t]),
    ...Object.keys(grouped).filter(t => !categoryOrder.includes(t)),
  ];

  for (const type of allTypes) {
    const cat = grouped[type];
    if (!cat || !cat.scripts) continue;

    let scripts = cat.scripts;

    // Apply "show inactive" filter
    if (!STATE.showInactive) {
      scripts = scripts.filter(s => s.isDeployed && !s.isInactive);
    }

    // Apply type filter pill
    if (STATE.activeFilter !== 'all' && type !== STATE.activeFilter) continue;

    // Apply search filter
    if (STATE.searchQuery) {
      const q = STATE.searchQuery.toLowerCase();
      scripts = scripts.filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.scriptScriptId || '').toLowerCase().includes(q) ||
        (s.deploymentScriptId || '').toLowerCase().includes(q) ||
        (s.entryPoints || []).some(ep => ep.toLowerCase().includes(q))
      );
    }

    if (scripts.length === 0) continue;

    totalVisible += scripts.length;

    // Build cards HTML — sub-group by entry point for UE and Client scripts
    let cardsHtml;
    const epOrder = EP_ORDER[type];
    if (epOrder) {
      const buckets = {}; // ep label → scripts[]
      const noBucket = []; // client scripts with no detected EP
      for (const s of scripts) {
        const eps = s.entryPoints || [];
        if (type === 'userevent') {
          // UE priority: beforeSubmit > afterSubmit > everything else → beforeLoad
          if (eps.includes('beforeSubmit')) {
            (buckets['beforeSubmit'] = buckets['beforeSubmit'] || []).push(s);
          } else if (eps.includes('afterSubmit')) {
            (buckets['afterSubmit'] = buckets['afterSubmit'] || []).push(s);
          } else {
            (buckets['beforeLoad'] = buckets['beforeLoad'] || []).push(s);
          }
        } else {
          // Client scripts: first matching EP in priority order
          const primary = epOrder.find(ep => eps.includes(ep));
          if (primary) {
            (buckets[primary] = buckets[primary] || []).push(s);
          } else {
            noBucket.push(s);
          }
        }
      }
      cardsHtml = noBucket.map(s => renderCard(s, cat.color)).join('');
      for (const ep of epOrder) {
        if (!buckets[ep]?.length) continue;
        cardsHtml += `<div class="ep-group-label">${escHtml(ep)}<span class="ep-group-count">${buckets[ep].length}</span></div>`;
        cardsHtml += buckets[ep].map(s => renderCard(s, cat.color)).join('');
      }
    } else {
      cardsHtml = scripts.map(s => renderCard(s, cat.color)).join('');
    }

    const section = document.createElement('div');
    section.className = 'category-section';
    section.innerHTML = `
      <div class="category-header">
        <div class="category-dot" style="background:${escHtml(cat.color)};"></div>
        <span class="category-label">${escHtml(cat.label)}</span>
        <span class="category-count">${scripts.length}</span>
      </div>
      ${cardsHtml}
    `;
    container.appendChild(section);
  }

  els.visibleCount.textContent = totalVisible;
  els.totalCountLabel.textContent = totalVisible === 1 ? 'script' : 'scripts';

  if (totalVisible === 0) {
    showOnly('emptyState');
  } else {
    showOnly('scriptsContainer');
  }
}

// ─── Card Click → Open Script in NetSuite ─────────────────────────────────────

function attachCardListeners() {
  els.scriptsContainer.addEventListener('click', e => {
    // Only navigate when clicking the script name
    const nameEl = e.target.closest('.script-name');
    if (!nameEl) return;
    const card = nameEl.closest('.script-card');
    if (!card) return;
    const url = card.dataset.scriptUrl;
    if (url) chrome.tabs.create({ url });
  });
}

// ─── Filtering & Search ───────────────────────────────────────────────────────

function setupFilters() {
  // Filter pills
  els.filterBar.addEventListener('click', e => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    STATE.activeFilter = pill.dataset.type;
    renderGroups(STATE.grouped);
  });

  // Search
  els.searchInput.addEventListener('input', e => {
    STATE.searchQuery = e.target.value.trim();
    renderGroups(STATE.grouped);
  });

  // Show inactive toggle
  els.showInactiveToggle.addEventListener('change', e => {
    STATE.showInactive = e.target.checked;
    renderGroups(STATE.grouped);
  });
}

// ─── Main Flow ────────────────────────────────────────────────────────────────

async function init() {
  setupFilters();
  setupTabs();
  attachCardListeners();
  setupFieldSearch();
  els.btnRetry.addEventListener('click', loadScripts);

  showOnly('loadingState');
  await loadScripts();
}

async function loadScripts() {
  showOnly('loadingState');

  // 1. Get the active tab
  let tab;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = activeTab;
  } catch (err) {
    showError('Cannot access tab', err.message);
    return;
  }

  if (!tab || !tab.url) {
    showOnly('nonNsState');
    return;
  }

  const url = tab.url;
  const isNS = url.includes('netsuite.com') || url.includes('app.netsuite.com');
  if (!isNS) {
    showOnly('nonNsState');
    return;
  }

  // 2. Ask content script for record info
  let recordInfo;
  try {
    recordInfo = await chrome.tabs.sendMessage(tab.id, { type: 'GET_RECORD_INFO' });
  } catch (err) {
    showError(
      'Content script not ready',
      'Refresh the NetSuite page and try again. (Content script not loaded.)'
    );
    return;
  }

  STATE.recordInfo = recordInfo;

  // Update header
  if (recordInfo.recordType) {
    els.recordTypeLabel.textContent = recordLabel(recordInfo.recordType);
  } else {
    els.recordTypeLabel.textContent = 'Unknown record';
  }

  if (!recordInfo.recordType) {
    showOnly('noRecordState');
    return;
  }

  // 3. Build base URL
  const hostname = new URL(url).hostname;
  // Use the actual hostname from the tab for the API call
  STATE.baseUrl = `https://${hostname}`;

  if (recordInfo.accountId) {
    els.accountTag.textContent = `Account: ${recordInfo.accountId}`;
  }

  // 4. Fetch scripts from background
  try {
    const response = await chrome.runtime.sendMessage({
      type:       'FETCH_SCRIPTS',
      baseUrl:    STATE.baseUrl,
      recordType: recordInfo.recordType,
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to fetch scripts');
    }

    STATE.grouped      = response.grouped;
    STATE.totalScripts = response.total;

    if (response.total === 0) {
      showOnly('emptyState');
    } else {
      renderGroups(STATE.grouped);
      detectEntryPoints(); // background — doesn't block initial render
    }
  } catch (err) {
    showError('API Error', err.message);
  }
}

// Fetches and parses JS source for UE/Client scripts to populate entryPoints[].
// Runs after initial render so it doesn't delay the script list appearing.
async function detectEntryPoints() {
  const scripts = [];
  for (const [type, cat] of Object.entries(STATE.grouped)) {
    for (const s of (cat.scripts || [])) {
      if (s.scriptFileId) scripts.push({ scriptId: s.scriptId, scriptFileId: s.scriptFileId, scriptType: type });
    }
  }
  if (!scripts.length) return;

  try {
    const response = await chrome.runtime.sendMessage({
      type:    'DETECT_ENTRY_POINTS',
      baseUrl: STATE.baseUrl,
      scripts,
    });
    if (!response?.success) return;

    const lockedSet = new Set(response.locked || []);
    let changed = false;
    for (const cat of Object.values(STATE.grouped)) {
      for (const s of (cat.scripts || [])) {
        if (lockedSet.has(s.scriptId) && !s.isLocked) {
          s.isLocked = true;
          changed = true;
        }
      }
    }
    if (changed) renderGroups(STATE.grouped);
  } catch {}
}

function showError(title, body) {
  $('error-title').textContent = title;
  $('error-body').textContent  = body;
  showOnly('errorState');
}

// ─── Tab Switching ────────────────────────────────────────────────────────────

function setupTabs() {
  const tabBar = $('tab-bar');
  if (!tabBar) return;

  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === STATE.activeTab) return;

    STATE.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (tab === 'scripts') {
      // Show scripts panel
      $('content').style.display = '';
      $('search-bar').style.display = '';
      $('filter-bar').style.display = '';
      $('field-search-panel').style.display = 'none';
      els.footerBar.style.display = els.scriptsContainer.style.display !== 'none' ? '' : 'none';
    } else {
      // Show field search panel
      $('content').style.display = 'none';
      $('search-bar').style.display = 'none';
      $('filter-bar').style.display = 'none';
      els.footerBar.style.display = 'none';
      $('field-search-panel').style.display = 'flex';
      // Show appropriate initial state
      showFsState(STATE.totalScripts > 0 ? 'idle' : 'no-scripts');
    }
  });
}

// ─── Field Search ─────────────────────────────────────────────────────────────

const SCRIPT_TYPE_COLORS = {
  clientscript:   { text: '#4f8ef7', bg: 'rgba(79,142,247,0.15)' },
  userevent:      { text: '#9b59b6', bg: 'rgba(155,89,182,0.15)' },
  suitelet:       { text: '#1abc9c', bg: 'rgba(26,188,156,0.15)' },
  mapreduce:      { text: '#e67e22', bg: 'rgba(230,126,34,0.15)' },
  scheduled:      { text: '#e74c3c', bg: 'rgba(231,76,60,0.15)' },
  restlet:        { text: '#3498db', bg: 'rgba(52,152,219,0.15)' },
  workflowaction: { text: '#f39c12', bg: 'rgba(243,156,18,0.15)' },
  portlet:        { text: '#2ecc71', bg: 'rgba(46,204,113,0.15)' },
  workflow:       { text: '#f39c12', bg: 'rgba(243,156,18,0.12)' },
};

const SCRIPT_TYPE_ABBR = {
  clientscript:       'CS',
  userevent:          'UE',
  suitelet:           'SL',
  mapreduce:          'MR',
  scheduled:          'SS',
  restlet:            'RL',
  workflowaction:     'WA',
  portlet:            'PT',
  massupdate:         'MU',
  bundleinstallation: 'BI',
  workflow:           'WF',
};

function showFsState(key) {
  const all = ['fs-loading', 'fs-results', 'fs-empty', 'fs-error', 'fs-no-scripts'];
  all.forEach(id => {
    const el = $(id);
    if (el) el.style.display = 'none';
  });
  if (key === 'idle') return; // just hide all, show nothing (initial state)
  if (key === 'loading') {
    $('fs-loading').style.display = 'flex';
  } else if (key === 'results') {
    $('fs-results').style.display = '';
  } else if (key === 'empty') {
    $('fs-empty').style.display = 'flex';
  } else if (key === 'error') {
    $('fs-error').style.display = 'flex';
  } else if (key === 'no-scripts') {
    $('fs-no-scripts').style.display = 'flex';
  }
}

function getAllScripts() {
  const scripts = [];
  for (const cat of Object.values(STATE.grouped)) {
    if (cat.scripts) scripts.push(...cat.scripts);
  }
  return scripts;
}

function renderFsResultCard(result, _fieldId) {
  const colors = SCRIPT_TYPE_COLORS[result.scriptType || result.kind] || { text: '#7f8c8d', bg: 'rgba(127,140,141,0.15)' };
  const kindLabel = result.kind === 'workflow' ? 'WF' : (SCRIPT_TYPE_ABBR[result.scriptType] || result.scriptType?.toUpperCase() || '??');

  const badgeStyle = `background:${colors.bg};color:${colors.text};border:1px solid ${colors.text}44;`;

  let bodyHtml = '';

  if (result.kind === 'workflow') {
    bodyHtml = `
      <div class="fs-result-meta">
        <span>📋 ${escHtml(result.scriptId || '')}</span>
        ${result.isInactive ? '<span style="color:#f87171">⛔ Inactive</span>' : ''}
      </div>
      <div class="fs-workflow-notice">
        ⚠️ ${escHtml(result.note)}
      </div>
    `;
  } else {
    const metaHtml = `
      <div class="fs-result-meta">
        <span>📋 ${escHtml(result.scriptId || '')}</span>
      </div>
    `;
    const matchesHtml = result.matches.map((m, _idx) => {
      const contextLines = m.context.map(cl => `
        <div class="code-line${cl.isMatch ? ' is-match' : ''}">
          <span class="code-line-num">${cl.num}</span>
          <span class="code-line-text">${escHtml(cl.text)}</span>
        </div>
      `).join('');
      return `
        <div class="fs-match-group">
          <div class="fs-match-label">Line ${m.lineNum}</div>
          <div class="code-context">${contextLines}</div>
        </div>
      `;
    }).join('');
    bodyHtml = metaHtml + matchesHtml;
  }

  const matchBadge = result.matchCount !== null
    ? `<span class="fs-match-count">${result.matchCount} match${result.matchCount !== 1 ? 'es' : ''}</span>`
    : `<span class="fs-match-count" style="background:rgba(243,156,18,0.12);border-color:rgba(243,156,18,0.25);color:#fbbf24;">Workflow</span>`;

  return `
    <div class="fs-result-card">
      <div class="fs-result-header">
        <span class="fs-type-badge" style="${badgeStyle}">${escHtml(kindLabel)}</span>
        <span class="fs-result-name">${escHtml(result.name)}</span>
        ${matchBadge}
      </div>
      <div class="fs-card-body">${bodyHtml}</div>
    </div>
  `;
}

function setupFieldSearch() {
  const btn   = $('btn-field-search');
  const input = $('field-id-input');
  if (!btn || !input) return;

  // Expand/collapse result cards via event delegation (avoids inline onclick / CSP issues)
  $('fs-results').addEventListener('click', e => {
    const header = e.target.closest('.fs-result-header');
    if (!header) return;
    const body = header.nextElementSibling;
    if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
  });

  const doSearch = async () => {
    const fieldId = input.value.trim();
    if (!fieldId) {
      input.focus();
      return;
    }

    const scripts = getAllScripts();
    if (!STATE.baseUrl || scripts.length === 0) {
      showFsState('no-scripts');
      return;
    }

    btn.disabled = true;
    const fsLoading = $('fs-loading');
    const fsLoadingText = $('fs-loading-text');
    showFsState('loading');
    fsLoading.style.display = 'flex';

    const total = scripts.filter(s => s.scriptFileId).length;
    let done = 0;

    // Update loading text as files are scanned
    const progressInterval = setInterval(() => {
      if (fsLoadingText) fsLoadingText.textContent = `Scanning ${done}/${total} script files…`;
    }, 400);

    try {
      const response = await chrome.runtime.sendMessage({
        type:       'SEARCH_FIELD',
        baseUrl:    STATE.baseUrl,
        fieldId,
        recordType: STATE.recordInfo?.recordType,
        scripts,    // pass full script objects (includes scriptFileId)
      });

      clearInterval(progressInterval);

      if (!response || !response.success) {
        throw new Error(response?.error || 'Search failed');
      }

      const { results, errors } = response;

      const fsResults = $('fs-results');
      fsResults.innerHTML = '';

      if (results.length === 0 && errors.length === 0) {
        $('fs-empty-field').textContent = fieldId;
        showFsState('empty');
        return;
      }

      // Summary bar
      const scriptHits     = results.filter(r => r.kind === 'script').length;
      const workflowCount  = results.filter(r => r.kind === 'workflow').length;
      const summaryParts   = [];
      if (scriptHits > 0)    summaryParts.push(`<strong>${scriptHits}</strong> script${scriptHits !== 1 ? 's' : ''} match`);
      if (workflowCount > 0) summaryParts.push(`<strong>${workflowCount}</strong> workflow${workflowCount !== 1 ? 's' : ''} on record`);

      const summary = document.createElement('div');
      summary.className = 'fs-summary-bar';
      summary.innerHTML = `<span>${summaryParts.join(' · ')}</span><span style="color:var(--text-muted)">"${escHtml(fieldId)}"</span>`;
      fsResults.appendChild(summary);

      // Result cards
      const cardsDiv = document.createElement('div');
      cardsDiv.innerHTML = results.map(r => renderFsResultCard(r, fieldId)).join('');
      fsResults.appendChild(cardsDiv);

      // Errors section (collapsed)
      if (errors.length > 0) {
        const errSection = document.createElement('div');
        errSection.className = 'fs-errors-section';
        errSection.innerHTML = `
          <div class="fs-errors-title">⚠️ ${errors.length} script${errors.length !== 1 ? 's' : ''} could not be scanned</div>
          ${errors.map(e => `<div class="fs-error-item"><strong>${escHtml(e.name)}</strong> — ${escHtml(e.error)}</div>`).join('')}
        `;
        fsResults.appendChild(errSection);
      }

      showFsState('results');

    } catch (err) {
      clearInterval(progressInterval);
      $('fs-error-title').textContent = 'Search failed';
      $('fs-error-body').textContent  = err.message;
      showFsState('error');
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', doSearch);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
