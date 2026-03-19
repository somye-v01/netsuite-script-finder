/**
 * background.js — NetSuite Script Finder (Service Worker)
 * Handles all API calls to NetSuite so they run in the extension's privileged context.
 */

/**
 * Normalises the `scripttype` value returned by SuiteQL to the internal key
 * used by this extension's CATEGORIES map.
 *
 * NetSuite can return e.g. "SCHEDULEDSCRIPT" for scheduled scripts,
 * "BUNDLEINSTALLATIONSCRIPT" for bundle install scripts, etc.
 * We lowercase everything first, then remap known variants.
 */
const SCRIPTTYPE_NORMALIZE = {
  // Direct matches (already lowercase)
  client:                     'clientscript',    // NetSuite SuiteQL returns "CLIENT"
  clientscript:               'clientscript',
  userevent:                  'userevent',
  scheduled:                  'scheduled',
  scheduledscript:            'scheduled',       // NetSuite alternate
  mapreduce:                  'mapreduce',
  mapreducescript:            'mapreduce',       // NetSuite alternate
  suitelet:                   'suitelet',
  restlet:                    'restlet',
  workflowaction:             'workflowaction',
  workflowactionscript:       'workflowaction',  // NetSuite alternate
  portlet:                    'portlet',
  portletscript:              'portlet',         // NetSuite alternate
  massupdate:                 'massupdate',
  massupdatescript:           'massupdate',      // NetSuite alternate
  bundleinstallation:         'bundleinstallation',
  bundleinstallationscript:   'bundleinstallation', // NetSuite alternate
};

/**
 * SuiteQL query to fetch all deployments for a given record type,
 * including script metadata, owner name, and entry points.
 */
function buildDeploymentQuery(recordType) {
  return `
    SELECT
      sd.id          AS deployment_id,
      sd.scriptid    AS deployment_scriptid,
      sd.status,
      sd.isdeployed,
      sd.recordtype,
      s.id           AS script_id,
      s.scriptfile   AS script_file_id,
      s.scripttype,
      s.name         AS script_name,
      s.scriptid     AS script_scriptid,
      s.description,
      s.isinactive,
      s.apiversion         AS script_apiversion,
      e.entityid           AS owner_name,
      s.beforeloadfunction    AS ep_beforeload,
      s.beforesubmitfunction  AS ep_beforesubmit,
      s.aftersubmitfunction   AS ep_aftersubmit,
      s.pageinitfunction      AS ep_pageinit,
      s.fieldchangedfunction  AS ep_fieldchanged,
      s.saverecordfunction    AS ep_saverecord,
      s.validatefieldfunction AS ep_validatefield,
      s.validatelinefunction  AS ep_validateline,
      s.validateinsertfunction AS ep_validateinsert
    FROM scriptdeployment sd
    JOIN script s ON sd.script = s.id
    LEFT JOIN entity e ON s.owner = e.id
    WHERE LOWER(sd.recordtype) = LOWER('${recordType.replace(/'/g, "''")}')
    ORDER BY s.scripttype, s.name
  `;
}

/**
 * Extracts entry points directly from SuiteQL script record fields.
 * A field value is truthy when NS stores the JS function name; null/'F' means not implemented.
 */
function extractEntryPoints(row, scriptType) {
  const ep = val => val && val !== 'F';
  if (scriptType === 'userevent') {
    return [
      ep(row.ep_beforeload)    ? 'beforeLoad'   : null,
      ep(row.ep_beforesubmit)  ? 'beforeSubmit'  : null,
      ep(row.ep_aftersubmit)   ? 'afterSubmit'   : null,
    ].filter(Boolean);
  }
  if (scriptType === 'clientscript') {
    return [
      ep(row.ep_pageinit)       ? 'pageInit'      : null,
      ep(row.ep_fieldchanged)   ? 'fieldChanged'  : null,
      ep(row.ep_saverecord)     ? 'saveRecord'    : null,
      ep(row.ep_validatefield)  ? 'validateField' : null,
      ep(row.ep_validateline)   ? 'validateLine'  : null,
      ep(row.ep_validateinsert) ? 'validateInsert': null,
    ].filter(Boolean);
  }
  return [];
}

/**
 * Executes a SuiteQL query against the active NetSuite session.
 * @param {string} baseUrl - e.g. https://1234567.app.netsuite.com
 * @param {string} query - SuiteQL query string
 * @param {number} [offset=0]
 * @param {number} [limit=1000]
 */
async function runSuiteQL(baseUrl, query, offset = 0, limit = 1000) {
  const url = `${baseUrl}/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Prefer': 'transient',
    },
    body: JSON.stringify({ q: query.trim() }),
  });

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 403) {
      try {
        const detail = JSON.parse(errText)?.['o:errorDetails']?.[0]?.detail || '';
        if (detail.includes('REST Web Services')) {
          throw new Error(
            'REST Web Services is not enabled on this NetSuite account. ' +
            'An admin must enable it at: Setup > Company > Enable Features > SuiteCloud tab > REST Web Services.'
          );
        }
      } catch (e) {
        if (e.message.includes('REST Web Services')) throw e;
      }
    }
    throw new Error(`SuiteQL error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Unwraps a SuiteQL value that may be a reference object { id, refName }
 * or a plain scalar. Always returns a plain string/number ID, or null.
 */
function sqlId(val) {
  if (!val) return null;
  if (typeof val === 'object') return val.id ?? null;
  return val;
}

/**
 * Groups deployment rows by script type.
 */
function groupByScriptType(rows) {
  const CATEGORIES = {
    clientscript:   { label: 'Client Scripts',      color: '#4f8ef7' },
    userevent:      { label: 'User Event Scripts',   color: '#9b59b6' },
    suitelet:       { label: 'Suitelets',            color: '#1abc9c' },
    mapreduce:      { label: 'Map / Reduce',         color: '#e67e22' },
    scheduled:      { label: 'Scheduled Scripts',    color: '#e74c3c' },
    restlet:        { label: 'RESTlets',             color: '#3498db' },
    workflowaction: { label: 'Workflow Actions',     color: '#f39c12' },
    portlet:        { label: 'Portlets',             color: '#2ecc71' },
    massupdate:     { label: 'Mass Update Scripts',  color: '#95a5a6' },
    bundleinstallation: { label: 'Bundle Install',   color: '#e056fd' },
  };

  const grouped = {};
  for (const row of rows) {
    // Normalise whatever NetSuite returns (e.g. "SCHEDULEDSCRIPT") to our key ("scheduled")
    const rawType = (row.scripttype || 'unknown').toLowerCase();
    const type    = SCRIPTTYPE_NORMALIZE[rawType] || rawType;
    if (!grouped[type]) {
      grouped[type] = {
        ...( CATEGORIES[type] || { label: type, color: '#7f8c8d' }),
        scripts: [],
      };
    }
    grouped[type].scripts.push({
      deploymentId:       sqlId(row.deployment_id),
      deploymentScriptId: row.deployment_scriptid,
      scriptId:           sqlId(row.script_id),
      scriptFileId:       sqlId(row.script_file_id),
      scriptScriptId:     row.script_scriptid,
      scriptType:         type,
      name:               row.script_name || row.script_scriptid,
      description:        row.description || '',
      status:             row.status,
      isDeployed:         row.isdeployed === 'T',
      isInactive:         row.isinactive === 'T',
      apiVersion:         row.script_apiversion || null,
      ownerName:          row.owner_name || null,
      entryPoints:        extractEntryPoints(row, type),
    });
  }
  return grouped;
}

/**
 * Fetches raw text content of a script file from the NetSuite File Cabinet.
 * @param {string} baseUrl
 * @param {string|number} fileId - internal ID of the file record
 * @returns {Promise<string>}
 */
async function fetchFileContent(baseUrl, fileId) {
  // Unwrap SuiteQL reference object if needed
  const id = fileId && typeof fileId === 'object' ? fileId.id : fileId;
  if (!id) throw new Error('No file ID provided');

  // Step 1: get the signed download URL from SuiteQL (includes c= and h= params required by NS)
  const query = `SELECT url FROM file WHERE id = ${Number(id)}`;
  const data = await runSuiteQL(baseUrl, query);
  const items = data.items || [];
  if (items.length === 0) return null;
  const fileUrl = items[0].url;
  if (!fileUrl) return null;

  // Step 2: fetch the file using the signed URL (relative path → prepend baseUrl)
  const downloadUrl = fileUrl.startsWith('http') ? fileUrl : `${baseUrl}${fileUrl}`;
  const res = await fetch(downloadUrl, { method: 'GET', credentials: 'include' });
  if (!res.ok) return null;
  return await res.text();
}

/**
 * Searches for a field reference within script source code.
 * Returns matched lines with surrounding context (±2 lines).
 * @param {string} source - full file content
 * @param {string} fieldId - field to search for (e.g. "custbody_amount")
 * @returns {Array<{lineNum: number, line: string, context: string[]}>}
 */
function searchFieldInSource(source, fieldId) {
  const lines = source.split('\n');
  const matches = [];
  const needle = fieldId.toLowerCase();
  const CONTEXT = 2; // lines before/after

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) {
      const start = Math.max(0, i - CONTEXT);
      const end   = Math.min(lines.length - 1, i + CONTEXT);
      const context = [];
      for (let c = start; c <= end; c++) {
        context.push({ num: c + 1, text: lines[c], isMatch: c === i });
      }
      matches.push({ lineNum: i + 1, line: lines[i].trim(), context });
      i += CONTEXT; // skip ahead to avoid duplicate context windows
    }
  }
  return matches;
}

/**
 * Queries workflows for a given record type.
 */
async function fetchWorkflowsForRecord(baseUrl, recordType) {
  const query = `
    SELECT
      w.id,
      w.name,
      w.scriptid,
      w.description,
      w.isinactive,
      w.initcontexts,
      w.inittriggertype
    FROM workflow w
    JOIN workflowrecordtype wrt ON w.id = wrt.workflow
    WHERE LOWER(wrt.recordtype) = LOWER('${recordType.replace(/'/g, "''")}')
    ORDER BY w.name
  `;
  try {
    const data = await runSuiteQL(baseUrl, query);
    return data.items || [];
  } catch {
    return []; // Workflows are optional — don't fail the whole search
  }
}

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {

  if (request.type === 'FETCH_SCRIPTS') {
    const { baseUrl, recordType } = request;
    const query = buildDeploymentQuery(recordType);

    runSuiteQL(baseUrl, query)
      .then(data => {
        const rows = data.items || [];
        const grouped = groupByScriptType(rows);
        sendResponse({ success: true, grouped, total: rows.length });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });

    return true; // async
  }

  // ── Lock Detection ───────────────────────────────────────────────────────────
  // Entry points now come directly from SuiteQL. This handler only checks locks.
  if (request.type === 'DETECT_ENTRY_POINTS') {
    const { baseUrl, scripts } = request;
    (async () => {
      const locked = [];
      const lockedFileIds = new Set();

      // Batch-query islocked on the file table (one round-trip for all files)
      const uniqueFileIds = [...new Set(
        scripts.map(s => sqlId(s.scriptFileId)).filter(Boolean).map(String)
      )];

      if (uniqueFileIds.length > 0) {
        try {
          const lockData = await runSuiteQL(baseUrl,
            `SELECT id, islocked FROM file WHERE id IN (${uniqueFileIds.join(',')})`
          );
          for (const row of (lockData.items || [])) {
            const isLocked = row.islocked === 'T' || row.islocked === true || row.islocked === 'true';
            if (isLocked) lockedFileIds.add(String(sqlId(row.id)));
          }
        } catch { /* islocked may not exist — fall through */ }
      }

      // For UE/CS not caught above, null content also means locked
      await Promise.all(scripts.map(async s => {
        const fileId = String(sqlId(s.scriptFileId));
        if (lockedFileIds.has(fileId)) { locked.push(s.scriptId); return; }
        if (s.scriptType !== 'userevent' && s.scriptType !== 'clientscript') return;
        try {
          const source = await fetchFileContent(baseUrl, s.scriptFileId);
          if (!source) locked.push(s.scriptId);
        } catch { locked.push(s.scriptId); }
      }));

      sendResponse({ success: true, locked });
    })();
    return true;
  }

  // ── Field Search ────────────────────────────────────────────────────────────
  if (request.type === 'SEARCH_FIELD') {
    const { baseUrl, fieldId, scripts, recordType } = request;

    (async () => {
      const results = [];
      const errors  = [];

      // 1. Search script source files in parallel
      const scriptJobs = scripts
        .filter(s => s.scriptFileId)
        .map(async script => {
          try {
            const source  = await fetchFileContent(baseUrl, script.scriptFileId);
            if (!source) return; // file not accessible — skip silently
            const matches = searchFieldInSource(source, fieldId);
            if (matches.length > 0) {
              results.push({
                kind:       'script',
                name:       script.name,
                scriptId:   script.scriptScriptId,
                scriptType: script.scriptType,
                fileId:     script.scriptFileId,
                matchCount: matches.length,
                matches,
              });
            }
          } catch (e) {
            errors.push({ name: script.name, error: e.message });
          }
        });

      await Promise.all(scriptJobs);

      // 2. Fetch workflows for this record type
      const workflows = await fetchWorkflowsForRecord(baseUrl, recordType);
      for (const wf of workflows) {
        results.push({
          kind:        'workflow',
          name:        wf.name,
          scriptId:    wf.scriptid,
          description: wf.description || '',
          isInactive:  wf.isinactive === 'T',
          note:        'Workflow definitions cannot be source-searched. Listed because it runs on this record type — review manually if needed.',
          matchCount:  null,
        });
      }

      // Sort: scripts with matches first, then workflows
      results.sort((a, b) => {
        if (a.kind === 'script' && b.kind === 'workflow') return -1;
        if (a.kind === 'workflow' && b.kind === 'script') return 1;
        return (b.matchCount || 0) - (a.matchCount || 0);
      });

      sendResponse({ success: true, results, errors });
    })();

    return true; // async
  }
});
