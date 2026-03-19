# NetSuite Script Finder — Chrome Extension

A read-only Chrome extension that instantly shows all script deployments on any NetSuite record — author, entry points, lock status, and more — using your existing browser session. Nothing is written or modified.

---

## Features

- **Auto-detects** the current NetSuite record type from the URL
- **Queries SuiteQL** using your active session (no OAuth, RESTlet, or API keys needed)
- **Script author** shown on every card (from the NS owner/entity join)
- **Entry point functions** shown per script type (beforeLoad, afterSubmit, pageInit, etc.)
- **Lock indicator** — shows a lock icon on bundle-protected scripts
- **Grouped by category**: Client Script, User Event, Suitelet, Map/Reduce, Scheduled, RESTlet, Workflow Actions, Portlets, Mass Update, Bundle Install
- **Field Search tab** — enter any field ID and scan all script source files on the record for references, with line-level context
- **Workflow listing** — lists all workflows deployed to the record type
- **Search** by name, Script ID, or entry point function name
- **Filter pills** by script type
- Toggle to show inactive/testing deployments

---

## Requirements

- Chrome (Manifest V3)
- NetSuite account with **REST Web Services** enabled
  *(Setup > Company > Enable Features > SuiteCloud tab > REST Web Services)*
- Your user needs **View** access to Script Deployments (`Setup > Scripting`)

---

## Installation (Developer Mode)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder
5. The extension icon appears in your toolbar — pin it for easy access

---

## How to Use

1. Log into NetSuite in Chrome as normal
2. Navigate to any record — e.g. a Sales Order:
   `https://XXXX.app.netsuite.com/app/accounting/transactions/salesord.nl?id=123`
3. Click the extension icon
4. The **Scripts tab** shows all deployed scripts for that record type
5. Use the **Field Search tab** to find which scripts reference a specific field ID

---

## Supported Record Types

40+ record types are supported out of the box, including:

| Category | Examples |
|---|---|
| Transactions | Sales Order, Purchase Order, Invoice, Credit Memo, Journal Entry, Item Fulfillment, Item Receipt, Cash Sale, Expense Report, and more |
| Entities | Customer, Employee, Vendor, Partner, Contact, Lead |
| Items | Inventory Item, Assembly Item, Service Item, Kit Item, and more |
| CRM | Opportunity, Estimate, Support Case, Campaign, Task |
| Custom Records | Any `customrecord_xxx` via `rectype.nl?rectype=` URL pattern |
| Accounting | Account, Department, Class, Location, Subsidiary |

---

## Architecture

```
netsuite-script-finder/
├── manifest.json     MV3 config — permissions: activeTab, tabs only
├── content.js        Detects record type from URL; responds to popup messages
├── background.js     Service worker — all SuiteQL API calls run here
├── popup.html        Extension popup shell
├── popup.js          Rendering, filtering, field search, tab switching
├── styles.css        Dark theme UI
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Technical Notes

### Authentication
Uses your existing NetSuite browser session (cookies). No OAuth, no tokens, no RESTlet required.

### SuiteQL Endpoint (read-only)
```
POST https://{account}.app.netsuite.com/services/rest/query/v1/suiteql
Body: { "q": "SELECT ..." }
```
SuiteQL only accepts `SELECT` statements — no writes are possible through this endpoint.

### Security
- **Read-only**: no `PATCH`, `PUT`, `DELETE`, or record-modifying calls anywhere
- **Minimal permissions**: only `activeTab` and `tabs` — no broad host access beyond `*.netsuite.com`
- **No external requests**: no analytics, telemetry, or third-party services
- **No data stored**: all state is in-memory and cleared when the popup closes
- All NetSuite data rendered in the UI is HTML-escaped before display
