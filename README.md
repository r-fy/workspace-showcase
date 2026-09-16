# Workspace

A self-built productivity and CRM platform — a Progressive Web App (PWA) combining notes, project management, expense tracking, calendaring, and a client relationship management (CRM) system with an integrated cold-calling dialer. Built and run as a live production application for daily business use, not a demo or portfolio sample.

## Demo

[Watch a video tour](demo/tour.mp4)

## What it does

**Notes** — A live-preview markdown editor built on CodeMirror 6, with full-text search, tagging, inline colored text, interactive tally counters for habit tracking, and an auto-generated outline/table-of-contents panel.

**Projects (Kanban)** — Drag-and-drop task boards with columns, tags (shared with Notes), a pinned "Top 3" priority tray per board, and archive/trash lifecycle management.

**Expenses** — A transaction log with CSV import (including bank-statement auto-detection and categorization), category filtering, sortable/resizable columns, multi-select bulk actions, and an interactive spending-over-time line chart.

**Calendar** — Reminders with flexible recurrence (daily/weekly/monthly/yearly, custom intervals, day-of-week selection), a combined agenda and month-grid view, and real browser push notifications that work even when the app is closed, including quick-action buttons directly in the notification.

**CRM** — A lead-first system tying together SEO/marketing audits, follow-ups, and call history per lead, with a merged activity timeline, rollup status badges, and an "unmatched" triage view for anything not yet linked to a lead.

**Dialer** — A browser-based outbound calling system (Twilio Voice), including automatic dual-channel call recording, in-call DTMF keypad support for phone trees, and inbound call routing with voicemail fallback.

**Prospect lists** — A lightweight, disposable tier below full CRM leads for working raw cold-call lists: bulk CSV/JSON import, per-row outcome tracking, live daily calling stats, and one-click promotion of a promising prospect into a full CRM lead. Includes a keyboard-driven "Navigator" mode for rapid list dialing.

**Audits** — Structured, client-ready written reports (Local SEO and Google Ads formats) with a live-rendering preview pane and PDF export, built from a repeatable template pipeline.

## How it's built

- **Backend:** Node.js + Express, with SQLite (via `better-sqlite3`) as the data store
- **Frontend:** Vanilla JavaScript (no framework), CodeMirror 6 for the rich text editor
- **Voice/Calling:** Twilio Voice JS SDK, server-side call routing and recording via Twilio webhooks
- **Offline support:** Service worker with a cache-first strategy, an IndexedDB-backed offline write queue with idempotency-key deduplication, and background sync on reconnect
- **Auth:** Token-based sessions (not raw credential passing), with failed-login rate limiting and lockout
- **Hosting:** Docker containers behind a Caddy reverse proxy on a Linode VPS, with an origin firewall restricting access to the CDN's published IP ranges
- **Deployment:** Content-hash-based cache versioning (no hand-typed version numbers) to keep the service worker and served assets always in sync

## Notes on this repository

This is the actual production codebase, including its full commit history, shared as a portfolio reference. Some internal planning documents, credentials, and personal data have been removed from the history before publishing. The app itself is live and in daily use.
