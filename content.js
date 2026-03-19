/**
 * content.js — NetSuite Script Finder
 * Runs in the context of the NetSuite tab.
 * Detects the current record type from the URL and responds to messages from popup.js.
 */

// Comprehensive mapping from URL path segments to NetSuite internal record type IDs
const URL_TO_RECORD_TYPE = {
  // ── Transactions ────────────────────────────────────────────────────────────
  'salesord':                    'salesorder',
  'purchord':                    'purchaseorder',
  'custinvc':                    'invoice',          // actual NS URL key
  'invoice':                     'invoice',          // alias
  'custcred':                    'creditmemo',       // actual NS URL key
  'creditmemo':                  'creditmemo',       // alias
  'customerpayment':             'customerpayment',
  'estimate':                    'estimate',
  'opprtnty':                    'opportunity',
  'casemgmt':                    'supportcase',
  'returnauth':                  'returnauthorization',
  'vendauth':                    'vendorauthorization',
  'vendpymt':                    'vendorpayment',
  'vendcred':                    'vendorcredit',
  'journalentry':                'journalentry',
  'intercompanyjournalentry':    'intercompanyjournalentry',
  'advintercompanyjournalentry': 'advintercompanyjournalentry',
  'transfer':                    'transfer',
  'invtransfer':                 'inventorytransfer',
  'itemreceipt':                 'itemreceipt',
  'itemfulfillment':             'itemfulfillment',
  'cashsale':                    'cashsale',
  'cashrefund':                  'cashrefund',
  'custdep':                     'customerdeposit',
  'custrefund':                  'customerrefund',
  'check':                       'check',
  'deposit':                     'deposit',
  'exprpt':                      'expensereport',
  'assembly':                    'assemblyunbuild',
  'assemblyunbuild':             'assemblyunbuild',
  'assemblybuild':               'assemblybuild',
  'workord':                     'workorder',
  'workordclose':                'workorderclose',
  'workordcompl':                'workordercompletion',
  'blanketpo':                   'blanketpurchaseorder',
  'purchcontract':               'purchasecontract',
  'inventoryadjustment':         'inventoryadjustment',
  'invcount':                    'physicalinventoryworksheet',

  // ── Payroll ─────────────────────────────────────────────────────────────────
  'paycheckjournal':             'paycheckjournal',
  'paycheck':                    'paycheck',

  // ── Time & Projects ─────────────────────────────────────────────────────────
  'timeentry':                   'timebill',         // NS internal type is timebill
  'timesheet':                   'timesheet',
  'project':                     'job',              // NS internal type is job
  'projecttask':                 'projecttask',
  'projecttemplate':             'projecttemplate',

  // ── Entities ────────────────────────────────────────────────────────────────
  'custjob':                     'customer',
  'employee':                    'employee',
  'vendor':                      'vendor',
  'partner':                     'partner',
  'contact':                     'contact',
  'lead':                        'lead',
  'prospect':                    'prospect',

  // ── Items ───────────────────────────────────────────────────────────────────
  'item':                        'item',
  'invitem':                     'inventoryitem',
  'description':                 'descriptionitem',
  'discountitem':                'discountitem',
  'giftcertif':                  'giftcertificateitem',
  'serviceitem':                 'serviceitem',
  'noninvitem':                  'noninventoryitem',
  'otherchargeitem':             'otherchargeitem',
  'assemblyitem':                'assemblyitem',
  'kititem':                     'kititem',
  'lotitem':                     'lotnumberedinventoryitem',
  'serialitem':                  'serializedinventoryitem',

  // ── CRM ─────────────────────────────────────────────────────────────────────
  'campaign':                    'campaign',
  'task':                        'task',
  'phonecall':                   'phonecall',
  'event':                       'calendarevent',
  'issue':                       'issue',

  // ── Documents / Other ───────────────────────────────────────────────────────
  'note':                        'note',
  'mediaitem':                   'mediaitem',
  'folder':                      'folder',
  'message':                     'message',

  // ── Accounting / Setup ──────────────────────────────────────────────────────
  'account':                     'account',
  'department':                  'department',
  'class':                       'classification',
  'location':                    'location',
  'subsidiary':                  'subsidiary',
  'currency':                    'currency',
  'term':                        'term',
  'paymentmethod':               'paymentmethod',
  'revrecarrangement':           'revrecarrangement',
  'billingschedule':             'billingschedule',
  'priceplan':                   'pricingplan',

  // ── Custom Records ──────────────────────────────────────────────────────────
  'rectype':                     'customrecord',   // ?rectype=customrecord_xxx handled below
  'custrecord':                  'customrecord',   // alternate NS path
};

/**
 * Extracts the NetSuite record type and account ID from the current page URL.
 * @returns {{ recordType: string|null, accountId: string|null, recordId: string|null, pageTitle: string }}
 */
function detectRecordInfo() {
  const url = window.location.href;
  const hostname = window.location.hostname;
  const pathname = window.location.pathname;
  const searchParams = new URLSearchParams(window.location.search);

  // Extract account ID from hostname: {accountId}.app.netsuite.com
  let accountId = null;
  const hostMatch = hostname.match(/^([a-z0-9_-]+)\.app\.netsuite\.com/i);
  if (hostMatch) {
    accountId = hostMatch[1];
  } else {
    // Try to get from the page's meta or cookie
    const metaMatch = document.cookie.match(/NS_ROUTING_VERSION=([^;]+)/);
    if (!metaMatch) {
      // Try extracting from NS_VER cookie or company ID in NS scripts
      const nsCompanyId = typeof window.NS !== 'undefined' && window.NS.COMPANY_ID
        ? window.NS.COMPANY_ID
        : null;
      accountId = nsCompanyId;
    }
  }

  // Parse the pathname for record type
  // Pattern: /app/{category}/{subcategory}/{recordPath}.nl
  const pathMatch = pathname.match(/\/app\/[^/]+\/[^/]+\/([^/.]+)\.nl$/i);
  let recordType = null;
  let pathKey = null;

  if (pathMatch) {
    pathKey = pathMatch[1].toLowerCase();
    recordType = URL_TO_RECORD_TYPE[pathKey] || null;

    // Handle custom record types:
    //   rectype.nl?rectype=customrecord_xxx  (standard NS)
    //   custrecord.nl?rectype=customrecord_xxx  (alternate)
    if (pathKey === 'rectype' || pathKey === 'custrecord') {
      const customType = searchParams.get('rectype');
      if (customType) {
        recordType = customType.toLowerCase();
      }
    }
  }

  // Record internal ID from URL
  const recordId = searchParams.get('id') || null;

  // Human-readable label from page title or our map
  const pageTitle = document.title || '';

  return {
    recordType,
    pathKey,
    accountId,
    recordId,
    pageTitle,
    url,
    isNetSuite: hostname.includes('netsuite.com'),
  };
}

// Listen for messages from popup.js / background.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_RECORD_INFO') {
    const info = detectRecordInfo();
    sendResponse(info);
  }
  return true; // keep channel open for async
});
