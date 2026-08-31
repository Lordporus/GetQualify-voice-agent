# RapidX Agency OS Design Contract

## 1. Product posture

RapidX Agency OS is the operating surface for a high-end automation agency. It must feel calm, exact, and financially literate. The product combines client operations, voice agents, revenue, invoices, integrations, support, and system prompts without making unavailable integrations appear live.

The primary user is an agency owner who needs to understand money, client health, and operational risk in under ten seconds. Secondary users are tenant owners and operators who need focused access to their own agents and usage.

## 2. Reference decisions

- Authentication uses the split-screen clarity found in the selected 21st.dev login component and Refero's Anam authentication screen. The form is quiet and narrow. The companion panel communicates product proof through real metrics and capabilities, not a decorative stock photograph.
- The agency dashboard takes its hierarchy from Refero's Anam analytics, Linktree insights, Dropbox activity, and Programa invoices screens. It uses a persistent navigation rail, a broad work canvas, compact metrics, filters, and dense but legible tables.
- Invoice structure follows the selected 21st.dev invoice-history component and Refero's Programa invoice workspace: summary metrics first, status filters second, then a semantic table with one dominant create action.
- Magic UI patterns are limited to an animated grid field on the authentication proof panel and restrained number tickers for headline metrics. Motion never competes with reading or financial decisions.
- Recharts is the only chart implementation. Area charts show change over time, bars compare clients, and a donut summarizes portfolio status. No chart duplicates a number that is clearer as a KPI.

## 3. Tokens

The canonical CSS tokens live in `public/assets/brand.css`.

- Canvas: warm ivory `#F6F4EE`.
- Primary surface: paper white `#FFFFFF`.
- Navigation surface: charcoal `#171713`.
- Primary ink: `#191814`.
- Secondary ink: `#666258`.
- Accent: precision gold `#B88A2D`.
- Positive: forest `#238667`.
- Warning: amber `#B96B21`.
- Critical: muted red `#BC4B52`.
- Informational: steel blue `#356A91`.
- Borders are quiet and visible. Shadows are shallow and structural.
- Radii use 10, 14, 18, and 24 pixels. Pills are reserved for status and filters.

## 4. Typography and spacing

- Use the native SF Pro and Inter-compatible system stack for speed and platform familiarity.
- Page titles use 28 to 34 pixels with tight tracking.
- KPI values use 28 to 40 pixels and tabular numerals.
- Labels use 11 to 13 pixels with sentence case. Uppercase is reserved for tiny section markers.
- Body copy uses 14 to 16 pixels with a maximum line length of 68 characters.
- The spacing scale is 4, 8, 12, 16, 20, 24, 32, and 40 pixels.

## 5. Primitives and states

### Buttons

- Primary actions use charcoal or gold, never gradients.
- Secondary actions use a white surface and visible border.
- Destructive actions use muted red and always state the target.
- Every button has default, hover, focus-visible, disabled, and loading states with a minimum 44 pixel target.

### Cards

- Cards have a one-pixel border and shallow shadow only when elevation conveys hierarchy.
- KPI cards include label, number, and one explanatory sentence or comparison.
- Integration cards always show one of: connected, setup required, requested, unavailable, or error.

### Tables

- Tables use semantic elements, sticky headers when long, horizontal scrolling on small screens, and text plus color for status.
- Empty, loading, and error states occupy the same table frame so the layout does not jump.
- Row actions remain visible without hover on touch devices.

### Charts

- Every chart has a visible title, time range, tooltip, accessible summary, and truthful empty state.
- Tooltips format money in INR and counts using Indian grouping.
- Animation is disabled under `prefers-reduced-motion`.
- Charts must fit at 375, 768, and 1280 pixel widths without clipped axes or legends.

### Forms and modals

- Labels are always visible. Placeholder text is an example, not the only label.
- Validation is inline and announced. Financial inputs show the currency and reject negative or malformed values unless the operation explicitly supports them.
- A created invoice is a stored agency record. It is not described as emailed unless an external delivery action has actually completed.

## 6. Product surfaces

### Authentication

- Left: logo, direct welcome message, email, password, inline error, primary submit, signup switch.
- Right: an animated grid field with agency metrics, live capability labels, and a clear statement of what the operator can control.
- The right panel hides below 900 pixels. The form remains vertically centered and uses the full safe viewport.

### Agency overview

- First row: revenue recorded, outstanding invoices, active clients, and client activity.
- Main chart: revenue and client activity over time.
- Secondary chart: client activity comparison.
- Portfolio summary: active, paused, onboarding, and offboarded clients.
- Recent activity and quick actions close the page.

### Clients and administration

- Client rows expose status, users, agents, wallet, recent activity, and invoice balance.
- Opening a workspace reveals users, agents, calls, billing, support, and audit context.
- Suspend and reactivate remain explicit, audited operations.

### Invoices

- Summary cards show outstanding, overdue, issued, and paid amounts.
- Operators can create and issue a stored invoice, filter it, inspect it, change its lifecycle state, and print a clean detail view.
- No external email or payment is implied by a local status change.

### Integrations

- WhatsApp Business Cloud and Meta Ad Library appear as real integration opportunities with accurate setup requirements.
- Cards show truthful state. An unconfigured connector never displays connected data.
- Requesting setup creates an auditable internal request. It does not call Meta or WhatsApp.

### Agency prompt

- One persistent agency-wide operating prompt is available to owner and admin roles.
- The page shows the current prompt, last editor, last update, character count, save state, and an explanation that per-agent prompts remain separate.

## 7. Motion, accessibility, and performance

- Animate only transform and opacity. No layout-property animation.
- Number tickers run once on entry and settle within 700 milliseconds.
- The authentication grid drifts slowly and stops under reduced motion.
- Focus order follows the visual order. Color is never the only status signal.
- The application targets WCAG 2.2 AA contrast, keyboard operation, zero console errors, and no horizontal document overflow.
- React and Recharts are bundled as a focused analytics island. The rest of the application stays framework-light. The chart bundle loads only on routes that mount charts.
