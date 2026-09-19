# Tawfeer — local savings app

توفير (Tawfeer) — "savings" in Arabic. A lightweight local web app for savings goals, priorities,
budgeting, Zakat tracking, and interest-free (Qard Hasan) loans. No database — everything is plain
JSON files in `data/`, organized by month.

## Setup (one time)

Open Terminal, go to this folder, then:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**Note on WeasyPrint (PDF export):** it needs a couple of system libraries that aren't part of
Python itself. If `pip install` succeeds but PDF export fails when you use the app, run:
```bash
brew install pango
```
then restart the app. This is a one-time setup step, specific to WeasyPrint on macOS.

## Run it

```bash
source venv/bin/activate   # if not already active
python3 app.py
```

Then open **http://127.0.0.1:5050** in your browser. Leave the Terminal window open while you use
the app; closing it stops the server. To stop manually, press `Ctrl+C` in the Terminal.

## Where your data lives

```
data/
  categories.json         <- savings categories (name, target, priority, pin, alert %, recurring)
  loans.json               <- person-to-person loans (Qard Hasan), with repayment history
  debts.json                <- Mourabaha / bank financing
  budget.json              <- monthly income and fixed expenses
  budget_history.json      <- a dated snapshot each time you save the budget
  zakat.json                <- Nisab settings, Hawl tracking, payment history
  settings.json             <- currency, date format, backup count, theme, density, PIN
  trash.json                 <- soft-deleted items (kept 30 days, restorable)
  months/
    2026-01.json            <- every transaction logged in January 2026
    2026-02.json
    ...
backups/
  2026-09-02/                <- a full daily snapshot of data/, made automatically on startup
```

Each transaction is stored in the file matching its date; editing a transaction's date moves it to
the right month file automatically.

## Features

**New in this version**
- **Dismiss a missing month** — once you've noted a month with no entries (e.g. it's genuinely empty),
  dismiss it and it stops nagging you. It can be undone from the Monthly View table.
- **Surplus Allocator: banknote-aware** — choose whether to allocate in 100 or 200 increments to
  match the notes you actually have. A "don't leave any amount unallocated" option (on by default)
  spreads every note somewhere, even topping up your highest-priority goal beyond its target rather
  than leaving cash unplaced; a genuine sub-note remainder (e.g. 50 MAD when only 100-notes are used)
  is called out separately rather than hidden.
**New in this version**
- **Priority scale, standardized to 1–5**: P1 Essential/urgent, P2 Very important, P3 Important,
  P4 Medium-term goal, P5 Optional/nice-to-have. Priority still matters most for where surplus money
  goes, but it's no longer the only factor — see "Smart priority" below.
- **Smart priority allocation** — the Surplus Allocator's "Smart priority" strategy ranks categories
  by an urgency score combining priority, deadline closeness, recurring status, and how far behind
  pace a goal is (not a plain priority-number sort).
- **Deadlines** — give any category a target date; Tawfeer shows days/months remaining and how much
  you need to save per month (and per week) to make it.
- **Recurring goals, properly modeled** — monthly, quarterly, yearly, or tied to an Islamic (Hijri)
  calendar event. Eid al-Adha ships as a default category using this: Tawfeer calculates the next
  10 Dhu al-Hijjah automatically via the `hijridate` library and marks it as an estimate, since the
  exact date depends on moon sighting.
- **Category types** — emergency, health, annual, goal, purchase, investment, personal, other — for
  future analysis, without forcing rigid grouping.
- **Zakat Hawl now uses a real Hijri year** (354 or 355 days, computed via `hijridate`) instead of a
  fixed 354-day approximation, and shows both the Gregorian and Hijri Hawl dates.
- **`.tawfeer` full backup format** — a single portable file (Settings → Full Tawfeer Backup) with
  everything: categories, transactions, loans, debts, budget, Zakat, settings. Versioned
  (`backupVersion`) independently from the app itself, with a migration hook so future format changes
  won't break old backups. Importing shows a preview (created date, app version, item counts,
  compatibility) before you confirm, and always makes a safety backup of your current data first.
- **16 default categories** on a fresh install (Emergency Fund, Umrah, Eid al-Adha, Back To School,
  etc.) — existing categories are never touched or overwritten by this or any future update.

**Core**
- Categories — targets, priorities (drag a card to reorder), icons (pick from a grid), pin to the
  top of the Dashboard, per-category alert threshold, recurring goals (e.g. Eid) with a "start new
  cycle" button. Add or withdraw money any time, with optional free-text tags.
- Surplus Allocator — spread a lump sum across several categories at once: priority cascade, even
  split, or custom percentages, with a preview before applying.
- Loans — interest-free (Qard Hasan) lending/borrowing tracker with partial repayments, plus
  one-click PDF and image exports of a loan statement.
- Debts — Mourabaha and other structured/bank financing, separate from person-to-person loans.
- Budget — fixed monthly expenses vs income, a 50/30/20 reference split, and a dated history of past
  budgets.
- Zakat — Nisab (gold/silver, with a staleness warning after 90 days), automatic Hawl tracking that
  resets if tracked savings dip below Nisab, a proactive due-date reminder, and a payment history
  log. This is a planning aid, not a religious ruling — see the notes on that page.
- Monthly View — animated, interactive charts (bar, line, donut, gauge) for savings trends, category
  breakdowns, debt payoff, and Zakat status; a yearly summary with year-over-year change; missing
  month detection with a Dashboard banner.

**Data safety**
- Trash — deleted categories, transactions, debts, and loans are recoverable for 30 days.
- Automatic daily backups of the whole `data/` folder, restorable from Settings (with a safety
  snapshot taken before any restore).
- Corrupted-file auto-recovery — if a core JSON file can't be read on startup, Tawfeer tries to heal
  it from the most recent backup automatically.
- Optional PIN lock with configurable auto-lock timing (Settings).

**Import / export**
- Import from Excel (openpyxl) — recognizes the original spreadsheet planner's "Goals" and "Monthly
  Tracker" sheets and migrates categories + transactions automatically.
- Export to Excel (XlsxWriter + matplotlib/seaborn) — a full workbook with embedded charts.
- Export a one-page PDF report, or a CSV of all transactions (WeasyPrint / csv).

**Interface**
- Search/filter transactions (by note, category, date, or tag) — press `/` to focus it.
- Dark mode (`T`) and a compact density option.
- Keyboard shortcuts: `N` new item, `/` search, `T` theme, `Esc` close dialog.
- Animated confirmation checkmark on key saves.

## Upgrading from an older version

If you already have data in `data/categories.json`, this update never overwrites it — the 16 default
categories only seed a brand-new installation. Your existing categories are automatically upgraded
in place the first time they're read (priority clamped to 1–5, new fields like `deadline` and `type`
backfilled as empty) — nothing is deleted or renamed.

## What this app doesn't do (by design)

- No multi-device sync — it's one JSON store on this Mac.
- No network exposure — only listens on `127.0.0.1`.
- The PIN lock is meant to deter casual access on a shared computer, not to withstand a determined
  attacker — the data files themselves aren't encrypted.
- The Zakat and Debts calculators are planning aids, not religious or legal advice.
