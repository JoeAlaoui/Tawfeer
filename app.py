"""
Tawfeer — local Flask app.
No database: data is stored as JSON files under data/ , one file per month
for transactions, plus categories.json and loans.json for the rest.
Runs entirely on localhost — nothing leaves this machine.
"""
import json
import os
import re
import shutil
import time
import uuid
from datetime import datetime, timedelta
from io import BytesIO

from flask import Flask, request, jsonify, render_template, send_file, abort
from werkzeug.security import generate_password_hash, check_password_hash

try:
    from hijridate import Hijri, Gregorian
    HIJRI_AVAILABLE = True
except ImportError:
    HIJRI_AVAILABLE = False

APP_VERSION = "1.5.0"
BACKUP_FORMAT_VERSION = 1

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
MONTHS_DIR = os.path.join(DATA_DIR, "months")
CATEGORIES_FILE = os.path.join(DATA_DIR, "categories.json")
LOANS_FILE = os.path.join(DATA_DIR, "loans.json")
ZAKAT_FILE = os.path.join(DATA_DIR, "zakat.json")
DEBTS_FILE = os.path.join(DATA_DIR, "debts.json")
BUDGET_FILE = os.path.join(DATA_DIR, "budget.json")
BUDGET_HISTORY_FILE = os.path.join(DATA_DIR, "budget_history.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
TRASH_FILE = os.path.join(DATA_DIR, "trash.json")
BACKUPS_DIR = os.path.join(BASE_DIR, "backups")

os.makedirs(MONTHS_DIR, exist_ok=True)
os.makedirs(BACKUPS_DIR, exist_ok=True)


def backup_on_startup(keep=10):
    """Copy the whole data/ folder into backups/<timestamp>/ once per day,
    and prune old backups beyond `keep`. Cheap insurance now that manual
    export/import is gone from the UI."""
    today_tag = datetime.now().strftime("%Y-%m-%d")
    dest = os.path.join(BACKUPS_DIR, today_tag)
    if not os.path.exists(dest) and os.path.isdir(DATA_DIR):
        try:
            shutil.copytree(DATA_DIR, dest)
        except Exception as e:
            print(f"[backup] skipped: {e}")
    # prune: keep only the `keep` most recent dated backup folders
    try:
        existing = sorted(
            d for d in os.listdir(BACKUPS_DIR)
            if os.path.isdir(os.path.join(BACKUPS_DIR, d)) and re.match(r"^\d{4}-\d{2}-\d{2}$", d)
        )
        for old in existing[:-keep]:
            shutil.rmtree(os.path.join(BACKUPS_DIR, old), ignore_errors=True)
    except Exception as e:
        print(f"[backup] prune skipped: {e}")

app = Flask(__name__)

# ------------------------------------------------------------------
# priority scale (1-5, standardized) & category types
# ------------------------------------------------------------------
PRIORITY_LABELS = {
    1: "Essential / urgent",
    2: "Very important",
    3: "Important",
    4: "Medium-term goal",
    5: "Optional / nice-to-have",
}

CATEGORY_TYPES = ["emergency", "health", "annual", "goal", "purchase", "investment", "personal", "other"]

# ------------------------------------------------------------------
# Hijri calendar helpers (uses hijridate; degrades gracefully if unavailable)
# ------------------------------------------------------------------
HIJRI_MONTHS = ["Muharram", "Safar", "Rabi al-Awwal", "Rabi al-Thani", "Jumada al-Awwal", "Jumada al-Thani",
                "Rajab", "Sha'ban", "Ramadan", "Shawwal", "Dhu al-Qadah", "Dhu al-Hijjah"]

def gregorian_to_hijri(g_date):
    """g_date: datetime.date or datetime -> (year, month, day) Hijri tuple, or None if unavailable."""
    if not HIJRI_AVAILABLE:
        return None
    g = Gregorian(g_date.year, g_date.month, g_date.day)
    h = g.to_hijri()
    return (h.year, h.month, h.day)

def hijri_to_gregorian(year, month, day):
    """Hijri (year, month, day) -> datetime.date, or None if unavailable."""
    if not HIJRI_AVAILABLE:
        return None
    h = Hijri(year, month, day)
    g = h.to_gregorian()
    return datetime(g.year, g.month, g.day).date()

def add_one_hijri_year(g_date):
    """Add exactly one Hijri (lunar) year to a Gregorian date — 354 or 355 days,
    not a fixed approximation. Used for the Zakat Hawl due date."""
    if not HIJRI_AVAILABLE:
        return g_date + timedelta(days=354)  # fallback approximation
    hy, hm, hd = gregorian_to_hijri(g_date)
    return hijri_to_gregorian(hy + 1, hm, hd)

def next_hijri_event(hijri_month, hijri_day, from_date=None):
    """Next upcoming Gregorian date of a recurring Hijri event (e.g. 10 Dhu al-Hijjah for Eid al-Adha),
    on or after `from_date` (defaults to today). Returns (gregorian_date, hijri_year) or (None, None)."""
    if not HIJRI_AVAILABLE:
        return None, None
    from_date = from_date or datetime.now().date()
    cur_hy, _, _ = gregorian_to_hijri(from_date)
    for hy in (cur_hy, cur_hy + 1):
        candidate = hijri_to_gregorian(hy, hijri_month, hijri_day)
        if candidate and candidate >= from_date:
            return candidate, hy
    return None, None

HIJRI_EVENTS = {
    "eid_al_adha": {"label": "Eid al-Adha", "month": 12, "day": 10},
    "eid_al_fitr": {"label": "Eid al-Fitr", "month": 10, "day": 1},
    "ramadan_start": {"label": "Start of Ramadan", "month": 9, "day": 1},
}

def resolve_category_deadline(cat):
    """For hijri_event recurring categories, the deadline is computed dynamically
    (always points to the next upcoming occurrence) rather than stored as a fixed date."""
    if cat.get("recurrenceFrequency") == "hijri_event" and cat.get("hijriEvent") in HIJRI_EVENTS:
        ev = HIJRI_EVENTS[cat["hijriEvent"]]
        g_date, hy = next_hijri_event(ev["month"], ev["day"])
        if g_date:
            return g_date.strftime("%Y-%m-%d"), hy
        return None, None
    return cat.get("deadline"), None

# ------------------------------------------------------------------
# low-level JSON helpers (this is our "database layer")
# ------------------------------------------------------------------
def _read_json(path, default, critical=False):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            print(f"[WARNING] {path} is corrupted.")
            if critical:
                healed = _try_heal_from_backup(path)
                if healed is not None:
                    print(f"[recovery] restored {os.path.basename(path)} from latest backup")
                    return healed
            return default

def _try_heal_from_backup(path):
    """Look through backups (newest first) for a working copy of this file."""
    rel = os.path.relpath(path, DATA_DIR)
    if not os.path.isdir(BACKUPS_DIR):
        return None
    for d in sorted(os.listdir(BACKUPS_DIR), reverse=True):
        candidate = os.path.join(BACKUPS_DIR, d, rel)
        if os.path.exists(candidate):
            try:
                with open(candidate, "r", encoding="utf-8") as f:
                    data = json.load(f)
                shutil.copy2(candidate, path)
                return data
            except (json.JSONDecodeError, OSError):
                continue
    return None

def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)  # atomic on same filesystem

def new_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:10]}"

def month_key_from_date(date_str):
    """'2026-03-17' -> '2026-03'"""
    return date_str[:7]

def month_path(month_key):
    if not re.match(r"^\d{4}-\d{2}$", month_key):
        abort(400, "Invalid month key")
    return os.path.join(MONTHS_DIR, f"{month_key}.json")

def load_month(month_key):
    return _read_json(month_path(month_key), {"month": month_key, "transactions": []})

def save_month(month_key, data):
    _write_json(month_path(month_key), data)

def list_month_keys():
    if not os.path.isdir(MONTHS_DIR):
        return []
    keys = [f[:-5] for f in os.listdir(MONTHS_DIR) if f.endswith(".json")]
    return sorted(keys)

def migrate_category(c):
    """Backfill new fields on categories saved before this version — never touches
    existing values, only adds missing keys so old data keeps working."""
    c.setdefault("type", None)
    c.setdefault("deadline", None)
    c.setdefault("cycleStart", None)
    c.setdefault("recurrenceFrequency", ("yearly" if c.get("recurring") else None))
    c.setdefault("hijriEvent", None)
    c["priority"] = max(1, min(5, int(c.get("priority", 3) or 3)))  # standardize to the 1-5 scale
    return c

def load_categories():
    data = _read_json(CATEGORIES_FILE, {"categories": []}, critical=True)
    data["categories"] = [migrate_category(c) for c in data.get("categories", [])]
    return data

def save_categories(data):
    _write_json(CATEGORIES_FILE, data)

def load_loans():
    return _read_json(LOANS_FILE, {"loans": []}, critical=True)

def save_loans(data):
    _write_json(LOANS_FILE, data)

def load_zakat():
    return _read_json(ZAKAT_FILE, default_zakat(), critical=True)

def save_zakat(data):
    _write_json(ZAKAT_FILE, data)

def load_debts():
    return _read_json(DEBTS_FILE, {"debts": []}, critical=True)

def save_debts(data):
    _write_json(DEBTS_FILE, data)

def load_budget():
    return _read_json(BUDGET_FILE, default_budget(), critical=True)

def save_budget(data):
    _write_json(BUDGET_FILE, data)

def load_budget_history():
    return _read_json(BUDGET_HISTORY_FILE, {"snapshots": []})

def save_budget_history(data):
    _write_json(BUDGET_HISTORY_FILE, data)

def load_trash():
    return _read_json(TRASH_FILE, {"items": []})

def save_trash(data):
    _write_json(TRASH_FILE, data)

def load_settings():
    s = _read_json(SETTINGS_FILE, default_settings(), critical=True)
    # backfill any keys added in later versions
    for k, v in default_settings().items():
        s.setdefault(k, v)
    return s

def save_settings(data):
    _write_json(SETTINGS_FILE, data)

def default_zakat():
    return {
        "nisabReference": "Silver",
        "goldPricePerGram": 1225,
        "silverPricePerGram": 22.8,
        "pricesUpdatedOn": datetime.now().strftime("%Y-%m-%d"),
        "goldNisabWeight": 87.48,
        "silverNisabWeight": 612.36,
        "includePlannerSavings": True,
        "otherWealth": 0,
        "debtsDeductible": 0,
        "hawlMethod": "Automatic",
        "manualHawlStart": datetime.now().strftime("%Y-%m-%d"),
        "payments": [],
    }

def default_budget():
    return {
        "monthlyIncome": 0,
        "expenses": [
            {"id": "e1", "name": "Rent / Housing", "amount": 0},
            {"id": "e2", "name": "Electricity & Water", "amount": 0},
            {"id": "e3", "name": "Internet & Phone", "amount": 0},
            {"id": "e4", "name": "Insurance", "amount": 0},
            {"id": "e5", "name": "Transport", "amount": 0},
            {"id": "e6", "name": "Food & Groceries", "amount": 0},
        ],
    }

def default_settings():
    return {
        "currency": "MAD",
        "backupsToKeep": 10,
        "dateFormat": "YYYY-MM-DD",
        "theme": "light",
        "density": "comfortable",
        "pinEnabled": False,
        "pinHash": None,
        "autoLockMinutes": 15,
        "dismissedMissingMonths": [],
    }

def all_transactions():
    """Every transaction across every month file, each tagged with its month."""
    out = []
    for mk in list_month_keys():
        m = load_month(mk)
        for t in m.get("transactions", []):
            t2 = dict(t)
            t2["month"] = mk
            out.append(t2)
    return out

def move_to_trash(item_type, data, extra=None):
    trash = load_trash()
    entry = {
        "id": new_id("tr"),
        "type": item_type,
        "data": data,
        "extra": extra or {},
        "deletedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    trash["items"].append(entry)
    save_trash(trash)
    return entry

def purge_old_trash(days=30):
    trash = load_trash()
    cutoff = datetime.now() - timedelta(days=days)
    kept = []
    for item in trash["items"]:
        try:
            ts = datetime.strptime(item["deletedAt"], "%Y-%m-%d %H:%M:%S")
        except (ValueError, KeyError):
            ts = datetime.now()
        if ts >= cutoff:
            kept.append(item)
    trash["items"] = kept
    save_trash(trash)

# ------------------------------------------------------------------
# seed data on first run
# ------------------------------------------------------------------
def default_categories():
    """Used only to seed a brand-new installation — never overwrites existing user data."""
    return [
        {"id": "c1", "icon": "🚨", "name": "Emergency Fund", "type": "emergency", "target": 40000, "priority": 1,
         "pinned": True, "alertThreshold": 90, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c2", "icon": "🏥", "name": "Health Fund", "type": "health", "target": 15000, "priority": 2,
         "pinned": False, "alertThreshold": 90, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c3", "icon": "🕋", "name": "Umrah", "type": "goal", "target": 40000, "priority": 3,
         "pinned": False, "alertThreshold": 90, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c4", "icon": "🚗", "name": "Car Fund", "type": "goal", "target": 120000, "priority": 4,
         "pinned": False, "alertThreshold": 90, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c_7290375dec", "icon": "🐑", "name": "Eid al-Adha", "type": "annual", "target": 6000, "priority": 2,
         "pinned": False, "alertThreshold": 90, "recurring": True, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": "hijri_event", "hijriEvent": "eid_al_adha"},
        {"id": "c_70515b983c", "icon": "🔧", "name": "Maintenance Fund", "type": "other", "target": 10000, "priority": 3,
         "pinned": False, "alertThreshold": 100, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c_ca5b633d7b", "icon": "🏠", "name": "House Down Payment", "type": "goal", "target": 120000, "priority": 4,
         "pinned": False, "alertThreshold": 90, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c_b2198f7b9c", "icon": "🏍", "name": "Motorcycle", "type": "goal", "target": 15000, "priority": 4,
         "pinned": False, "alertThreshold": 90, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c_7895c33c75", "icon": "🏖", "name": "Holidays", "type": "annual", "target": 10000, "priority": 5,
         "pinned": False, "alertThreshold": 90, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c_a505d8e0c5", "icon": "👤", "name": "Personal", "type": "personal", "target": 5000, "priority": 5,
         "pinned": False, "alertThreshold": 100, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c_0bf17cd42c", "icon": "🎓", "name": "Education Fund", "type": "goal", "target": 20000, "priority": 3,
         "pinned": False, "alertThreshold": 90, "recurring": True, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": "yearly", "hijriEvent": None},
        {"id": "c_50cebfb600", "icon": "👶", "name": "Back To School", "type": "annual", "target": 4000, "priority": 3,
         "pinned": False, "alertThreshold": 90, "recurring": True, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": "yearly", "hijriEvent": None},
        {"id": "c_4444934309", "icon": "⚠", "name": "Unexpected Costs", "type": "emergency", "target": 10000, "priority": 2,
         "pinned": False, "alertThreshold": 90, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c_11624dc898", "icon": "🛍", "name": "Shopping/Furniture", "type": "personal", "target": 10000, "priority": 5,
         "pinned": False, "alertThreshold": 90, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c_9390799313", "icon": "📈", "name": "Investment", "type": "investment", "target": 10000, "priority": 4,
         "pinned": False, "alertThreshold": 90, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
        {"id": "c_94653aa89b", "icon": "🎁", "name": "Gifts", "type": "personal", "target": 5000, "priority": 5,
         "pinned": False, "alertThreshold": 100, "recurring": False, "cycleStart": None,
         "deadline": None, "recurrenceFrequency": None, "hijriEvent": None},
    ]

def seed_if_empty():
    cats = load_categories()
    if not cats.get("categories"):
        # Fresh install only — existing user categories are never touched or overwritten.
        save_categories({"categories": default_categories()})
    if not os.path.exists(LOANS_FILE):
        save_loans({"loans": []})
    if not os.path.exists(ZAKAT_FILE):
        save_zakat(default_zakat())
    if not os.path.exists(DEBTS_FILE):
        save_debts({"debts": []})
    if not os.path.exists(BUDGET_FILE):
        save_budget(default_budget())
    if not os.path.exists(BUDGET_HISTORY_FILE):
        save_budget_history({"snapshots": []})
    if not os.path.exists(TRASH_FILE):
        save_trash({"items": []})
    if not os.path.exists(SETTINGS_FILE):
        save_settings(default_settings())
    today_month = datetime.now().strftime("%Y-%m")
    if today_month not in list_month_keys():
        save_month(today_month, {"month": today_month, "transactions": []})

seed_if_empty()
backup_on_startup()
purge_old_trash()

# ------------------------------------------------------------------
# PIN lock (single local session — this app has exactly one user)
# ------------------------------------------------------------------
_session = {"unlocked": True, "last_activity": time.time()}

def _pin_required():
    s = load_settings()
    return bool(s.get("pinEnabled") and s.get("pinHash"))

@app.before_request
def _check_lock():
    if request.path in ("/", "/static") or request.path.startswith("/static/"):
        return
    if request.path.startswith("/api/auth/"):
        return
    if not _pin_required():
        return
    settings = load_settings()
    timeout = settings.get("autoLockMinutes", 15) * 60
    if _session["unlocked"] and (time.time() - _session["last_activity"]) > timeout:
        _session["unlocked"] = False
    if not _session["unlocked"]:
        abort(401, "locked")
    _session["last_activity"] = time.time()

@app.route("/api/auth/status")
def auth_status():
    required = _pin_required()
    return jsonify({"pinEnabled": required, "unlocked": (not required) or _session["unlocked"]})

@app.route("/api/auth/unlock", methods=["POST"])
def auth_unlock():
    body = request.get_json(force=True)
    s = load_settings()
    if not s.get("pinHash") or not check_password_hash(s["pinHash"], body.get("pin", "")):
        abort(401, "wrong pin")
    _session["unlocked"] = True
    _session["last_activity"] = time.time()
    return jsonify({"unlocked": True})

@app.route("/api/auth/lock", methods=["POST"])
def auth_lock():
    _session["unlocked"] = False
    return jsonify({"unlocked": False})

@app.route("/api/auth/set-pin", methods=["POST"])
def auth_set_pin():
    body = request.get_json(force=True)
    s = load_settings()
    # if a PIN is already set, require the current one before changing it
    if s.get("pinHash") and not check_password_hash(s["pinHash"], body.get("currentPin", "")):
        abort(401, "wrong current pin")
    new_pin = body.get("newPin", "")
    if not new_pin or len(new_pin) < 4:
        abort(400, "PIN must be at least 4 digits")
    s["pinHash"] = generate_password_hash(new_pin)
    s["pinEnabled"] = True
    save_settings(s)
    _session["unlocked"] = True
    _session["last_activity"] = time.time()
    return jsonify({"pinEnabled": True})

@app.route("/api/auth/disable-pin", methods=["POST"])
def auth_disable_pin():
    body = request.get_json(force=True)
    s = load_settings()
    if s.get("pinHash") and not check_password_hash(s["pinHash"], body.get("currentPin", "")):
        abort(401, "wrong current pin")
    s["pinEnabled"] = False
    s["pinHash"] = None
    save_settings(s)
    _session["unlocked"] = True
    return jsonify({"pinEnabled": False})

# ------------------------------------------------------------------
# pages
# ------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")

# ------------------------------------------------------------------
# category enrichment — deadlines, Hijri events, and the multi-factor
# urgency score used to power "smart" allocation (priority is the
# dominant factor but not the only one)
# ------------------------------------------------------------------
PRIORITY_WEIGHT = {1: 5, 2: 4, 3: 3, 4: 2, 5: 1}

def enrich_category(cat, txns):
    balance = sum(t["amount"] for t in txns if t["categoryId"] == cat["id"])
    remaining_amount = max(0.0, cat["target"] - balance)
    resolved_deadline, hijri_year = resolve_category_deadline(cat)

    days_remaining = months_remaining = amount_per_month = amount_per_week = None
    today = datetime.now().date()
    if resolved_deadline:
        try:
            d = datetime.strptime(resolved_deadline, "%Y-%m-%d").date()
            days_remaining = (d - today).days
            months_remaining = max(0, round(days_remaining / 30.44))
            if remaining_amount > 0 and days_remaining > 0:
                amount_per_month = remaining_amount / max(1, days_remaining / 30.44)
                amount_per_week = remaining_amount / max(1, days_remaining / 7)
        except ValueError:
            pass

    # pace: only computable when we know both a start date and a deadline
    pace_status = None
    if cat.get("cycleStart") and resolved_deadline:
        try:
            start = datetime.strptime(cat["cycleStart"], "%Y-%m-%d").date()
            d = datetime.strptime(resolved_deadline, "%Y-%m-%d").date()
            total_days = (d - start).days
            elapsed_days = (today - start).days
            if total_days > 0 and elapsed_days > 0:
                expected_fraction = min(1.0, max(0.0, elapsed_days / total_days))
                expected_amount = cat["target"] * expected_fraction
                if expected_amount > 0:
                    ratio = balance / expected_amount
                    pace_status = "on_track" if ratio >= 0.95 else ("slightly_behind" if ratio >= 0.75 else "behind")
        except (ValueError, ZeroDivisionError):
            pass

    hijri_display = None
    if cat.get("recurrenceFrequency") == "hijri_event" and cat.get("hijriEvent") in HIJRI_EVENTS and hijri_year:
        ev = HIJRI_EVENTS[cat["hijriEvent"]]
        month_name = HIJRI_MONTHS[ev["month"] - 1]
        hijri_display = f"{ev['day']} {month_name} {hijri_year}"

    score = PRIORITY_WEIGHT.get(cat["priority"], 3) * 10
    if remaining_amount <= 0:
        score = 0
    else:
        if days_remaining is not None:
            if days_remaining <= 0: score += 50
            elif days_remaining <= 30: score += 40
            elif days_remaining <= 90: score += 25
            elif days_remaining <= 180: score += 12
            elif days_remaining <= 365: score += 5
        if cat.get("recurring"):
            score += 3
        if pace_status == "behind":
            score += 8
        elif pace_status == "slightly_behind":
            score += 4

    out = dict(cat)
    out.update({
        "balance": balance,
        "remainingAmount": remaining_amount,
        "resolvedDeadline": resolved_deadline,
        "hijriYear": hijri_year,
        "hijriDisplay": hijri_display,
        "hijriAvailable": HIJRI_AVAILABLE,
        "daysRemaining": days_remaining,
        "monthsRemaining": months_remaining,
        "amountPerMonth": round(amount_per_month, 2) if amount_per_month else None,
        "amountPerWeek": round(amount_per_week, 2) if amount_per_week else None,
        "paceStatus": pace_status,
        "urgencyScore": round(score, 1),
        "priorityLabel": PRIORITY_LABELS.get(cat["priority"], ""),
    })
    return out

# ------------------------------------------------------------------
# state (everything the frontend needs in one call)
# ------------------------------------------------------------------
@app.route("/api/state")
def api_state():
    debts = load_debts()["debts"]
    for d in debts:
        d["remaining"] = _debt_remaining(d)
    txns = all_transactions()
    categories = [enrich_category(c, txns) for c in load_categories()["categories"]]
    return jsonify({
        "categories": categories,
        "loans": load_loans()["loans"],
        "debts": debts,
        "transactions": txns,
        "months": list_month_keys(),
        "priorityLabels": PRIORITY_LABELS,
        "categoryTypes": CATEGORY_TYPES,
        "hijriAvailable": HIJRI_AVAILABLE,
    })

# ------------------------------------------------------------------
# categories
# ------------------------------------------------------------------
@app.route("/api/categories", methods=["POST"])
def create_category():
    body = request.get_json(force=True)
    data = load_categories()
    cat = {
        "id": new_id("c"),
        "icon": (body.get("icon") or "💰")[:4],
        "name": body.get("name", "").strip(),
        "type": body.get("type") or None,
        "target": float(body.get("target") or 0),
        "priority": max(1, min(5, int(body.get("priority") or 3))),
        "pinned": bool(body.get("pinned", False)),
        "alertThreshold": int(body.get("alertThreshold", 90)),
        "recurring": bool(body.get("recurring", False)),
        "cycleStart": body.get("cycleStart"),
        "deadline": body.get("deadline") or None,
        "recurrenceFrequency": body.get("recurrenceFrequency") or None,
        "hijriEvent": body.get("hijriEvent") or None,
    }
    if not cat["name"]:
        abort(400, "name is required")
    data["categories"].append(cat)
    save_categories(data)
    return jsonify(cat), 201

@app.route("/api/categories/<cat_id>", methods=["PUT"])
def update_category(cat_id):
    body = request.get_json(force=True)
    data = load_categories()
    for c in data["categories"]:
        if c["id"] == cat_id:
            c["icon"] = (body.get("icon") or c["icon"])[:4]
            c["name"] = body.get("name", c["name"]).strip() or c["name"]
            c["target"] = float(body.get("target", c["target"]))
            c["priority"] = max(1, min(5, int(body.get("priority", c["priority"]))))
            if "pinned" in body: c["pinned"] = bool(body["pinned"])
            if "alertThreshold" in body: c["alertThreshold"] = int(body["alertThreshold"])
            if "recurring" in body: c["recurring"] = bool(body["recurring"])
            if "cycleStart" in body: c["cycleStart"] = body["cycleStart"]
            if "type" in body: c["type"] = body["type"] or None
            if "deadline" in body: c["deadline"] = body["deadline"] or None
            if "recurrenceFrequency" in body: c["recurrenceFrequency"] = body["recurrenceFrequency"] or None
            if "hijriEvent" in body: c["hijriEvent"] = body["hijriEvent"] or None
            save_categories(data)
            return jsonify(c)
    abort(404)

@app.route("/api/categories/<cat_id>/new-cycle", methods=["POST"])
def start_new_cycle(cat_id):
    data = load_categories()
    for c in data["categories"]:
        if c["id"] == cat_id:
            c["cycleStart"] = datetime.now().strftime("%Y-%m-%d")
            save_categories(data)
            return jsonify(c)
    abort(404)

@app.route("/api/categories/<cat_id>", methods=["DELETE"])
def delete_category(cat_id):
    data = load_categories()
    cat = next((c for c in data["categories"] if c["id"] == cat_id), None)
    if cat is None:
        abort(404)
    data["categories"] = [c for c in data["categories"] if c["id"] != cat_id]
    save_categories(data)
    entry = move_to_trash("category", cat)
    return jsonify({"trashId": entry["id"]}), 200

# ------------------------------------------------------------------
# transactions (stored inside the month file matching their date)
# ------------------------------------------------------------------
@app.route("/api/transactions", methods=["POST"])
def create_transaction():
    body = request.get_json(force=True)
    date = body.get("date") or datetime.now().strftime("%Y-%m-%d")
    mk = month_key_from_date(date)
    m = load_month(mk)
    txn = {
        "id": new_id("t"),
        "categoryId": body["categoryId"],
        "date": date,
        "amount": float(body["amount"]),
        "note": body.get("note", "").strip(),
        "tags": [t.strip() for t in body.get("tags", []) if t.strip()],
    }
    m["transactions"].append(txn)
    save_month(mk, m)
    txn_out = dict(txn); txn_out["month"] = mk
    return jsonify(txn_out), 201

def _find_transaction(txn_id):
    for mk in list_month_keys():
        m = load_month(mk)
        for t in m["transactions"]:
            if t["id"] == txn_id:
                return mk, m, t
    return None, None, None

@app.route("/api/transactions/<txn_id>", methods=["PUT"])
def update_transaction(txn_id):
    body = request.get_json(force=True)
    mk, m, t = _find_transaction(txn_id)
    if t is None:
        abort(404)
    new_date = body.get("date", t["date"])
    new_mk = month_key_from_date(new_date)
    # remove from old month
    m["transactions"] = [x for x in m["transactions"] if x["id"] != txn_id]
    save_month(mk, m)
    t["date"] = new_date
    t["categoryId"] = body.get("categoryId", t["categoryId"])
    t["amount"] = float(body.get("amount", t["amount"]))
    t["note"] = body.get("note", t["note"])
    if "tags" in body:
        t["tags"] = [tag.strip() for tag in body["tags"] if tag.strip()]
    dest = load_month(new_mk)
    dest["transactions"].append(t)
    save_month(new_mk, dest)
    out = dict(t); out["month"] = new_mk
    return jsonify(out)

@app.route("/api/transactions/<txn_id>", methods=["DELETE"])
def delete_transaction(txn_id):
    mk, m, t = _find_transaction(txn_id)
    if t is None:
        abort(404)
    m["transactions"] = [x for x in m["transactions"] if x["id"] != txn_id]
    save_month(mk, m)
    entry = move_to_trash("transaction", t, extra={"month": mk})
    return jsonify({"trashId": entry["id"]}), 200
    return "", 204

# ------------------------------------------------------------------
# whole-month operations
# ------------------------------------------------------------------
@app.route("/api/months/<month_key>", methods=["DELETE"])
def delete_month(month_key):
    p = month_path(month_key)
    if os.path.exists(p):
        os.remove(p)
    return "", 204

# ------------------------------------------------------------------
# surplus allocator — batch write across several categories at once
# ------------------------------------------------------------------
@app.route("/api/allocate", methods=["POST"])
def allocate():
    body = request.get_json(force=True)
    date = body.get("date") or datetime.now().strftime("%Y-%m-%d")
    mk = month_key_from_date(date)
    m = load_month(mk)
    created = []
    for item in body.get("allocations", []):
        amount = float(item["amount"])
        if amount <= 0:
            continue
        txn = {
            "id": new_id("t"),
            "categoryId": item["categoryId"],
            "date": date,
            "amount": amount,
            "note": item.get("note", "Surplus allocation"),
        }
        m["transactions"].append(txn)
        created.append(txn)
    save_month(mk, m)
    return jsonify(created), 201

# ------------------------------------------------------------------
# loans
# ------------------------------------------------------------------
@app.route("/api/loans", methods=["POST"])
def create_loan():
    body = request.get_json(force=True)
    data = load_loans()
    loan = {
        "id": new_id("l"),
        "type": body.get("type", "lent"),
        "person": body.get("person", "").strip(),
        "principal": float(body.get("principal") or 0),
        "date": body.get("date") or datetime.now().strftime("%Y-%m-%d"),
        "note": body.get("note", "").strip(),
        "repayments": [],
    }
    if not loan["person"] or loan["principal"] <= 0:
        abort(400, "person and principal are required")
    data["loans"].append(loan)
    save_loans(data)
    return jsonify(loan), 201

@app.route("/api/loans/<loan_id>", methods=["DELETE"])
def delete_loan(loan_id):
    data = load_loans()
    loan = next((l for l in data["loans"] if l["id"] == loan_id), None)
    if loan is None:
        abort(404)
    data["loans"] = [l for l in data["loans"] if l["id"] != loan_id]
    save_loans(data)
    entry = move_to_trash("loan", loan)
    return jsonify({"trashId": entry["id"]}), 200

@app.route("/api/loans/<loan_id>/repayments", methods=["POST"])
def add_repayment(loan_id):
    body = request.get_json(force=True)
    data = load_loans()
    for l in data["loans"]:
        if l["id"] == loan_id:
            rep = {
                "id": new_id("r"),
                "date": body.get("date") or datetime.now().strftime("%Y-%m-%d"),
                "amount": float(body["amount"]),
                "note": body.get("note", "").strip(),
            }
            l["repayments"].append(rep)
            save_loans(data)
            return jsonify(rep), 201
    abort(404)

@app.route("/api/loans/<loan_id>/repayments/<rep_id>", methods=["DELETE"])
def delete_repayment(loan_id, rep_id):
    data = load_loans()
    for l in data["loans"]:
        if l["id"] == loan_id:
            l["repayments"] = [r for r in l["repayments"] if r["id"] != rep_id]
            save_loans(data)
            return "", 204
    abort(404)

def _get_loan(loan_id):
    data = load_loans()
    for l in data["loans"]:
        if l["id"] == loan_id:
            return l
    abort(404)

def _loan_remaining(loan):
    repaid = sum(r["amount"] for r in loan["repayments"])
    return max(0.0, loan["principal"] - repaid)

# ------------------------------------------------------------------
# debts (Mourabaha / bank financing — distinct from person-to-person loans)
# ------------------------------------------------------------------
def _debt_remaining(debt):
    start = datetime.strptime(debt["startDate"], "%Y-%m-%d")
    months_elapsed = max(0, (datetime.now().year - start.year) * 12 + (datetime.now().month - start.month))
    return max(0.0, debt["originalAmount"] - debt["monthlyPayment"] * months_elapsed)

@app.route("/api/debts")
def list_debts():
    data = load_debts()
    for d in data["debts"]:
        d["remaining"] = _debt_remaining(d)
    return jsonify(data["debts"])

@app.route("/api/debts", methods=["POST"])
def create_debt():
    body = request.get_json(force=True)
    data = load_debts()
    debt = {
        "id": new_id("d"),
        "description": body.get("description", "").strip() or "Debt",
        "type": body.get("type", "Mourabaha"),
        "originalAmount": float(body.get("originalAmount") or 0),
        "monthlyPayment": float(body.get("monthlyPayment") or 0),
        "startDate": body.get("startDate") or datetime.now().strftime("%Y-%m-%d"),
        "note": body.get("note", "").strip(),
    }
    data["debts"].append(debt)
    save_debts(data)
    debt_out = dict(debt); debt_out["remaining"] = _debt_remaining(debt)
    return jsonify(debt_out), 201

@app.route("/api/debts/<debt_id>", methods=["PUT"])
def update_debt(debt_id):
    body = request.get_json(force=True)
    data = load_debts()
    for d in data["debts"]:
        if d["id"] == debt_id:
            d["description"] = body.get("description", d["description"])
            d["type"] = body.get("type", d["type"])
            d["originalAmount"] = float(body.get("originalAmount", d["originalAmount"]))
            d["monthlyPayment"] = float(body.get("monthlyPayment", d["monthlyPayment"]))
            d["startDate"] = body.get("startDate", d["startDate"])
            d["note"] = body.get("note", d["note"])
            save_debts(data)
            out = dict(d); out["remaining"] = _debt_remaining(d)
            return jsonify(out)
    abort(404)

@app.route("/api/debts/<debt_id>", methods=["DELETE"])
def delete_debt(debt_id):
    data = load_debts()
    debt = next((d for d in data["debts"] if d["id"] == debt_id), None)
    if debt is None:
        abort(404)
    data["debts"] = [d for d in data["debts"] if d["id"] != debt_id]
    save_debts(data)
    entry = move_to_trash("debt", debt)
    return jsonify({"trashId": entry["id"]}), 200

# ------------------------------------------------------------------
# budget (fixed monthly expenses vs income)
# ------------------------------------------------------------------
@app.route("/api/budget")
def get_budget():
    return jsonify(load_budget())

@app.route("/api/budget", methods=["PUT"])
def update_budget():
    body = request.get_json(force=True)
    data = load_budget()
    if "monthlyIncome" in body:
        data["monthlyIncome"] = float(body["monthlyIncome"])
    if "expenses" in body:
        data["expenses"] = [
            {"id": e.get("id") or new_id("e"), "name": e.get("name", "").strip() or "Expense",
             "amount": float(e.get("amount") or 0)}
            for e in body["expenses"]
        ]
    save_budget(data)
    # snapshot into history — at most once per calendar day, to avoid noisy duplicates
    hist = load_budget_history()
    today = datetime.now().strftime("%Y-%m-%d")
    total_expenses = sum(e["amount"] for e in data["expenses"])
    if not hist["snapshots"] or hist["snapshots"][-1]["date"] != today:
        hist["snapshots"].append({"date": today, "income": data["monthlyIncome"], "totalExpenses": total_expenses})
    else:
        hist["snapshots"][-1] = {"date": today, "income": data["monthlyIncome"], "totalExpenses": total_expenses}
    save_budget_history(hist)
    return jsonify(data)

@app.route("/api/budget/history")
def get_budget_history():
    return jsonify(load_budget_history()["snapshots"])

# ------------------------------------------------------------------
# zakat
# ------------------------------------------------------------------
def _nisab_value(z):
    if z["nisabReference"] == "Gold":
        return z["goldPricePerGram"] * z["goldNisabWeight"]
    return z["silverPricePerGram"] * z["silverNisabWeight"]

def _zakatable_wealth(z):
    planner_savings = total_saved_all_categories() if z.get("includePlannerSavings", True) else 0
    return max(0.0, planner_savings + float(z.get("otherWealth") or 0) - float(z.get("debtsDeductible") or 0))

def total_saved_all_categories():
    cats = load_categories()["categories"]
    txns = all_transactions()
    total = 0.0
    for c in cats:
        total += sum(t["amount"] for t in txns if t["categoryId"] == c["id"])
    return total

def _detect_hawl_start(z):
    """Walk the monthly cumulative-savings history and find the start of the
    current unbroken run of months where total savings stayed >= Nisab.
    Resets whenever savings dip back below Nisab — mirrors the spreadsheet logic."""
    nisab = _nisab_value(z)
    months = list_month_keys()
    if not months:
        return None
    cats = load_categories()["categories"]
    cat_ids = {c["id"] for c in cats}
    running = 0.0
    start = None
    today_key = datetime.now().strftime("%Y-%m")
    for mk in sorted(months):
        if mk > today_key:
            break
        m = load_month(mk)
        for t in m.get("transactions", []):
            if t["categoryId"] in cat_ids:
                running += t["amount"]
        if running >= nisab and nisab > 0:
            if start is None:
                start = mk + "-01"
        else:
            start = None
    return start

@app.route("/api/zakat")
def get_zakat():
    z = load_zakat()
    nisab = _nisab_value(z)
    wealth = _zakatable_wealth(z)
    auto_start = _detect_hawl_start(z)
    hawl_start = auto_start if z.get("hawlMethod", "Automatic") == "Automatic" else z.get("manualHawlStart")
    due_date = None
    days_remaining = None
    hawl_complete = False
    hawl_start_hijri = due_date_hijri = None
    if hawl_start:
        start_dt = datetime.strptime(hawl_start, "%Y-%m-%d").date()
        due_dt = add_one_hijri_year(start_dt)  # a real Hijri (lunar) year: 354 or 355 days, not a fixed count
        due_date = due_dt.strftime("%Y-%m-%d")
        days_remaining = (due_dt - datetime.now().date()).days
        hawl_complete = datetime.now().date() >= due_dt
        if HIJRI_AVAILABLE:
            hy1 = gregorian_to_hijri(start_dt)
            hy2 = gregorian_to_hijri(due_dt)
            if hy1: hawl_start_hijri = f"{hy1[2]} {HIJRI_MONTHS[hy1[1]-1]} {hy1[0]}"
            if hy2: due_date_hijri = f"{hy2[2]} {HIJRI_MONTHS[hy2[1]-1]} {hy2[0]}"
    total_paid = sum(p["amount"] for p in z.get("payments", []))
    price_stale = (datetime.now() - datetime.strptime(z["pricesUpdatedOn"], "%Y-%m-%d")).days > 90 if z.get("pricesUpdatedOn") else True
    above_nisab = wealth >= nisab and nisab > 0
    due_now = above_nisab and hawl_complete
    return jsonify({
        "settings": z,
        "nisabValue": nisab,
        "zakatableWealth": wealth,
        "aboveNisab": above_nisab,
        "hawlStart": hawl_start,
        "hawlStartHijri": hawl_start_hijri,
        "hawlAutoDetected": auto_start,
        "dueDate": due_date,
        "dueDateHijri": due_date_hijri,
        "hijriAvailable": HIJRI_AVAILABLE,
        "daysRemaining": days_remaining,
        "hawlComplete": hawl_complete,
        "zakatDueNow": round(wealth * 0.025, 2) if due_now else 0,
        "zakatIfDueToday": round(wealth * 0.025, 2) if above_nisab else 0,
        "totalPaidAllTime": total_paid,
        "priceStale": price_stale,
    })

@app.route("/api/zakat/settings", methods=["PUT"])
def update_zakat_settings():
    body = request.get_json(force=True)
    z = load_zakat()
    for key in ["nisabReference", "goldPricePerGram", "silverPricePerGram", "pricesUpdatedOn",
                "includePlannerSavings", "otherWealth", "debtsDeductible", "hawlMethod", "manualHawlStart"]:
        if key in body:
            z[key] = body[key]
    save_zakat(z)
    return jsonify(z)

@app.route("/api/zakat/payments", methods=["POST"])
def add_zakat_payment():
    body = request.get_json(force=True)
    z = load_zakat()
    payment = {
        "id": new_id("zp"),
        "date": body.get("date") or datetime.now().strftime("%Y-%m-%d"),
        "amount": float(body.get("amount") or 0),
        "reference": body.get("reference", "").strip(),
        "note": body.get("note", "").strip(),
    }
    z.setdefault("payments", []).append(payment)
    save_zakat(z)
    return jsonify(payment), 201

@app.route("/api/zakat/payments/<payment_id>", methods=["DELETE"])
def delete_zakat_payment(payment_id):
    z = load_zakat()
    z["payments"] = [p for p in z.get("payments", []) if p["id"] != payment_id]
    save_zakat(z)
    return "", 204

# ------------------------------------------------------------------
# trash (soft-delete recovery)
# ------------------------------------------------------------------
def _restore_trash_item(entry):
    t = entry["type"]
    d = entry["data"]
    if t == "category":
        data = load_categories()
        if not any(c["id"] == d["id"] for c in data["categories"]):
            data["categories"].append(d)
            save_categories(data)
    elif t == "transaction":
        mk = entry.get("extra", {}).get("month") or month_key_from_date(d["date"])
        m = load_month(mk)
        if not any(x["id"] == d["id"] for x in m["transactions"]):
            m["transactions"].append(d)
            save_month(mk, m)
    elif t == "debt":
        data = load_debts()
        if not any(x["id"] == d["id"] for x in data["debts"]):
            data["debts"].append(d)
            save_debts(data)
    elif t == "loan":
        data = load_loans()
        if not any(x["id"] == d["id"] for x in data["loans"]):
            data["loans"].append(d)
            save_loans(data)

@app.route("/api/trash")
def list_trash():
    return jsonify(load_trash()["items"])

@app.route("/api/trash/<trash_id>/restore", methods=["POST"])
def restore_trash(trash_id):
    trash = load_trash()
    entry = next((i for i in trash["items"] if i["id"] == trash_id), None)
    if entry is None:
        abort(404)
    _restore_trash_item(entry)
    trash["items"] = [i for i in trash["items"] if i["id"] != trash_id]
    save_trash(trash)
    return jsonify({"restored": True})

@app.route("/api/trash/<trash_id>", methods=["DELETE"])
def delete_trash_forever(trash_id):
    trash = load_trash()
    trash["items"] = [i for i in trash["items"] if i["id"] != trash_id]
    save_trash(trash)
    return "", 204

@app.route("/api/trash", methods=["DELETE"])
def empty_trash():
    save_trash({"items": []})
    return "", 204

# ------------------------------------------------------------------
# backups (list + restore)
# ------------------------------------------------------------------
@app.route("/api/backups")
def list_backups():
    if not os.path.isdir(BACKUPS_DIR):
        return jsonify([])
    dates = sorted(
        (d for d in os.listdir(BACKUPS_DIR) if os.path.isdir(os.path.join(BACKUPS_DIR, d))),
        reverse=True,
    )
    return jsonify(dates)

@app.route("/api/backups/<date>/restore", methods=["POST"])
def restore_backup(date):
    src = os.path.join(BACKUPS_DIR, date)
    if not os.path.isdir(src):
        abort(404, "No backup for that date")
    # safety net: snapshot current data before overwriting, so a bad restore is itself recoverable
    safety_tag = "pre-restore-" + datetime.now().strftime("%Y-%m-%d_%H%M%S")
    safety_dest = os.path.join(BACKUPS_DIR, safety_tag)
    if os.path.isdir(DATA_DIR):
        shutil.copytree(DATA_DIR, safety_dest)
    for name in os.listdir(src):
        s, d = os.path.join(src, name), os.path.join(DATA_DIR, name)
        if os.path.isdir(s):
            if os.path.isdir(d):
                shutil.rmtree(d)
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)
    return jsonify({"restored": date, "safetyBackup": safety_tag})

# ------------------------------------------------------------------
# .tawfeer portable backup — a ZIP with a versioned manifest, containing
# every JSON file needed to fully restore the app's state elsewhere.
# ------------------------------------------------------------------
import zipfile

def _tawfeer_manifest():
    cats = load_categories()["categories"]
    txns = all_transactions()
    return {
        "format": "tawfeer-backup",
        "backupVersion": BACKUP_FORMAT_VERSION,
        "appVersion": APP_VERSION,
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "currency": load_settings().get("currency", "MAD"),
        "counts": {
            "categories": len(cats),
            "transactions": len(txns),
            "months": len(list_month_keys()),
            "loans": len(load_loans()["loans"]),
            "debts": len(load_debts()["debts"]),
        },
    }

@app.route("/api/export/tawfeer")
def export_tawfeer():
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(_tawfeer_manifest(), indent=2))
        zf.writestr("categories.json", json.dumps(load_categories(), indent=2, ensure_ascii=False))
        zf.writestr("loans.json", json.dumps(load_loans(), indent=2, ensure_ascii=False))
        zf.writestr("debts.json", json.dumps(load_debts(), indent=2, ensure_ascii=False))
        zf.writestr("budget.json", json.dumps(load_budget(), indent=2, ensure_ascii=False))
        zf.writestr("budget_history.json", json.dumps(load_budget_history(), indent=2, ensure_ascii=False))
        zf.writestr("zakat.json", json.dumps(load_zakat(), indent=2, ensure_ascii=False))
        zf.writestr("settings.json", json.dumps(load_settings(), indent=2, ensure_ascii=False))
        for mk in list_month_keys():
            zf.writestr(f"transactions/{mk}.json", json.dumps(load_month(mk), indent=2, ensure_ascii=False))
    buf.seek(0)
    fname = f"Tawfeer_Backup_{datetime.now().strftime('%Y-%m-%d_%H%M')}.tawfeer"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fname)

def _read_tawfeer_zip(file_storage):
    try:
        zf = zipfile.ZipFile(file_storage)
    except zipfile.BadZipFile:
        abort(400, "This doesn't look like a valid .tawfeer file.")
    names = zf.namelist()
    if "manifest.json" not in names:
        abort(400, "Missing manifest.json — this isn't a Tawfeer backup.")
    manifest = json.loads(zf.read("manifest.json"))
    if manifest.get("format") != "tawfeer-backup":
        abort(400, "Unrecognized backup format.")
    return zf, manifest

def _migrate_backup_contents(files, from_version):
    """Pluggable migration chain: each step upgrades `files` (a dict of filename -> parsed JSON)
    from one backup format version to the next. No-op today since we're still on v1, but this is
    where future migrations plug in without breaking old backups."""
    version = from_version
    while version < BACKUP_FORMAT_VERSION:
        migration_fn = BACKUP_MIGRATIONS.get(version)
        if not migration_fn:
            break
        files = migration_fn(files)
        version += 1
    return files

BACKUP_MIGRATIONS = {
    # 1: migrate_v1_to_v2,  # example of how a future migration would register here
}

@app.route("/api/import/tawfeer/preview", methods=["POST"])
def preview_tawfeer_import():
    if "file" not in request.files:
        abort(400, "No file uploaded")
    zf, manifest = _read_tawfeer_zip(request.files["file"])
    backup_version = manifest.get("backupVersion", 1)
    compatible = backup_version <= BACKUP_FORMAT_VERSION
    return jsonify({
        "manifest": manifest,
        "compatible": compatible,
        "currentAppVersion": APP_VERSION,
        "currentBackupVersion": BACKUP_FORMAT_VERSION,
    })

@app.route("/api/import/tawfeer/confirm", methods=["POST"])
def confirm_tawfeer_import():
    if "file" not in request.files:
        abort(400, "No file uploaded")
    zf, manifest = _read_tawfeer_zip(request.files["file"])
    backup_version = manifest.get("backupVersion", 1)
    if backup_version > BACKUP_FORMAT_VERSION:
        abort(400, f"This backup (v{backup_version}) is newer than this version of Tawfeer supports (v{BACKUP_FORMAT_VERSION}). Update the app first.")

    # Step 1: safety backup of current data before touching anything
    safety_tag = "pre-import-" + datetime.now().strftime("%Y-%m-%d_%H%M%S")
    if os.path.isdir(DATA_DIR):
        shutil.copytree(DATA_DIR, os.path.join(BACKUPS_DIR, safety_tag))

    # Step 2: read + migrate all files from the archive
    files = {}
    for name in zf.namelist():
        if name.endswith(".json") and name != "manifest.json":
            files[name] = json.loads(zf.read(name))
    files = _migrate_backup_contents(files, backup_version)

    # Step 3: apply — replace data files and rebuild months/ entirely from the backup
    if "categories.json" in files: save_categories(files["categories.json"])
    if "loans.json" in files: save_loans(files["loans.json"])
    if "debts.json" in files: save_debts(files["debts.json"])
    if "budget.json" in files: save_budget(files["budget.json"])
    if "budget_history.json" in files: save_budget_history(files["budget_history.json"])
    if "zakat.json" in files: save_zakat(files["zakat.json"])
    if "settings.json" in files: save_settings(files["settings.json"])

    if os.path.isdir(MONTHS_DIR):
        shutil.rmtree(MONTHS_DIR)
    os.makedirs(MONTHS_DIR, exist_ok=True)
    for name, content in files.items():
        if name.startswith("transactions/") and name.endswith(".json"):
            mk = os.path.basename(name)[:-5]
            save_month(mk, content)

    return jsonify({"imported": True, "safetyBackup": safety_tag, "manifest": manifest})

# ------------------------------------------------------------------
# settings
# ------------------------------------------------------------------
@app.route("/api/settings")
def get_settings():
    return jsonify(load_settings())

@app.route("/api/settings", methods=["PUT"])
def update_settings():
    body = request.get_json(force=True)
    s = load_settings()
    for key in ["currency", "backupsToKeep", "dateFormat", "theme", "density", "autoLockMinutes"]:
        if key in body:
            s[key] = body[key]
    save_settings(s)
    return jsonify(s)

@app.route("/api/settings/dismiss-missing-month", methods=["POST"])
def dismiss_missing_month():
    body = request.get_json(force=True)
    month = body.get("month")
    if not month or not re.match(r"^\d{4}-\d{2}$", month):
        abort(400, "Invalid month")
    s = load_settings()
    dismissed = set(s.get("dismissedMissingMonths", []))
    dismissed.add(month)
    s["dismissedMissingMonths"] = sorted(dismissed)
    save_settings(s)
    return jsonify(s["dismissedMissingMonths"])

@app.route("/api/settings/undismiss-missing-month", methods=["POST"])
def undismiss_missing_month():
    body = request.get_json(force=True)
    month = body.get("month")
    s = load_settings()
    dismissed = [m for m in s.get("dismissedMissingMonths", []) if m != month]
    s["dismissedMissingMonths"] = dismissed
    save_settings(s)
    return jsonify(s["dismissedMissingMonths"])

# ------------------------------------------------------------------
# CSV export (kept — quick raw dump, complements the Excel export below)
# ------------------------------------------------------------------
@app.route("/api/export/transactions.csv")
def export_transactions_csv():
    import csv, io
    cats = {c["id"]: c["name"] for c in load_categories()["categories"]}
    txns = sorted(all_transactions(), key=lambda t: t["date"])
    sbuf = io.StringIO()
    writer = csv.writer(sbuf)
    writer.writerow(["Date", "Month", "Category", "Amount", "Note"])
    for t in txns:
        writer.writerow([t["date"], t["month"], cats.get(t["categoryId"], "(deleted)"), t["amount"], t.get("note", "")])
    buf = BytesIO(sbuf.getvalue().encode("utf-8"))
    buf.seek(0)
    return send_file(buf, mimetype="text/csv", as_attachment=True,
                      download_name=f"transactions_{datetime.now().strftime('%Y%m%d')}.csv")

# ------------------------------------------------------------------
# PDF export — WeasyPrint (HTML + CSS -> PDF), reusing the app's own look
# ------------------------------------------------------------------
PDF_BASE_CSS = """
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: 'DejaVu Sans', sans-serif; color: #26313d; font-size: 11px; }
  h1 { color: #ffffff; background: #1f4e78; padding: 14px 18px; border-radius: 8px; font-size: 20px; margin: 0 0 16px; }
  h2 { color: #1f4e78; font-size: 14px; border-bottom: 2px solid #e3e8ee; padding-bottom: 4px; margin-top: 22px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { background: #1f4e78; color: #fff; text-align: left; padding: 6px 8px; font-size: 10px; text-transform: uppercase; }
  td { padding: 6px 8px; border-bottom: 1px solid #e3e8ee; }
  .kpi-row { display: flex; gap: 10px; margin-top: 10px; }
  .kpi { flex: 1; background: #f7f9fc; border: 1px solid #e3e8ee; border-radius: 8px; padding: 10px 12px; }
  .kpi .label { font-size: 9px; color: #7c8a99; text-transform: uppercase; }
  .kpi .value { font-size: 16px; font-weight: 700; color: #1f4e78; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 9px; font-weight: 700; }
  .tag.lent { background: #e6f4ea; color: #1e9e6b; }
  .tag.borrowed { background: #fdecea; color: #c0392b; }
  .footer-note { font-size: 9px; color: #7c8a99; margin-top: 24px; font-style: italic; }
"""

EMOJI_PATTERN = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\U00002190-\U000021FF\U00002B00-\U00002BFF]+",
    flags=re.UNICODE,
)

def strip_emoji(text):
    """WeasyPrint has no colour-emoji font available, so icons render as broken
    glyphs in PDFs — strip them here and keep the plain text looking clean."""
    return EMOJI_PATTERN.sub("", text or "").strip()

def render_pdf(html_body, title="Document"):
    full_html = f"<html><head><meta charset='utf-8'><style>{PDF_BASE_CSS}</style></head><body>{html_body}</body></html>"
    from weasyprint import HTML as WeasyHTML
    pdf_bytes = WeasyHTML(string=full_html, base_url=BASE_DIR).write_pdf()
    buf = BytesIO(pdf_bytes)
    buf.seek(0)
    return buf

@app.route("/api/loans/<loan_id>/pdf")
def loan_pdf(loan_id):
    loan = _get_loan(loan_id)
    remaining = _loan_remaining(loan)
    repaid = loan["principal"] - remaining
    currency = load_settings().get("currency", "MAD")
    tag_class = "lent" if loan["type"] == "lent" else "borrowed"
    tag_label = "They owe me" if loan["type"] == "lent" else "I owe them"

    rows = "".join(
        f"<tr><td>{r['date']}</td><td>{r['amount']:,.0f} {currency}</td><td>{r.get('note') or ''}</td></tr>"
        for r in sorted(loan["repayments"], key=lambda x: x["date"])
    ) or '<tr><td colspan="3">No repayments logged yet.</td></tr>'

    html = f"""
    <h1>Loan Statement — Qard Hasan (interest-free)</h1>
    <p><b>{loan['person']}</b> &nbsp; <span class="tag {tag_class}">{tag_label}</span></p>
    <div class="kpi-row">
      <div class="kpi"><div class="label">Original amount</div><div class="value">{loan['principal']:,.0f} {currency}</div></div>
      <div class="kpi"><div class="label">Repaid</div><div class="value">{repaid:,.0f} {currency}</div></div>
      <div class="kpi"><div class="label">Remaining</div><div class="value">{remaining:,.0f} {currency}</div></div>
    </div>
    <h2>Repayment history</h2>
    <table><thead><tr><th>Date</th><th>Amount</th><th>Note</th></tr></thead><tbody>{rows}</tbody></table>
    <p class="footer-note">This is an informal record generated for personal tracking, not a legal contract.
    No interest is charged or implied, consistent with an interest-free (Qard Hasan) loan.
    Loan date: {loan['date']}. {('Note: ' + loan['note']) if loan.get('note') else ''}</p>
    """
    buf = render_pdf(html)
    fname = f"loan_{loan['person'].replace(' ', '_')}_{loan_id}.pdf"
    return send_file(buf, mimetype="application/pdf", as_attachment=True, download_name=fname)

@app.route("/api/report/pdf")
def full_report_pdf():
    currency = load_settings().get("currency", "MAD")
    cats = load_categories()["categories"]
    txns = all_transactions()
    def bal(cid): return sum(t["amount"] for t in txns if t["categoryId"] == cid)
    total_saved = sum(bal(c["id"]) for c in cats)
    total_target = sum(c["target"] for c in cats)
    debts = load_debts()["debts"]
    for d in debts:
        d["remaining"] = _debt_remaining(d)
    total_debt = sum(d["remaining"] for d in debts)
    z = load_zakat()
    nisab = _nisab_value(z)
    wealth = _zakatable_wealth(z)
    budget = load_budget()
    total_expenses = sum(e["amount"] for e in budget["expenses"])

    cat_rows = "".join(
        f"<tr><td>{strip_emoji(c['name'])}</td><td>{c['target']:,.0f} {currency}</td>"
        f"<td>{bal(c['id']):,.0f} {currency}</td>"
        f"<td>{(bal(c['id'])/c['target']*100 if c['target'] else 0):.0f}%</td></tr>"
        for c in sorted(cats, key=lambda x: x["priority"])
    ) or "<tr><td colspan='4'>No categories yet.</td></tr>"

    html = f"""
    <h1>Tawfeer — Family Savings Report</h1>
    <p>Generated on {datetime.now().strftime('%Y-%m-%d')}</p>
    <div class="kpi-row">
      <div class="kpi"><div class="label">Total saved</div><div class="value">{total_saved:,.0f} {currency}</div></div>
      <div class="kpi"><div class="label">Total target</div><div class="value">{total_target:,.0f} {currency}</div></div>
      <div class="kpi"><div class="label">Net worth</div><div class="value">{(total_saved-total_debt):,.0f} {currency}</div></div>
    </div>
    <h2>Savings goals</h2>
    <table><thead><tr><th>Category</th><th>Target</th><th>Saved</th><th>Progress</th></tr></thead><tbody>{cat_rows}</tbody></table>
    <h2>Budget</h2>
    <div class="kpi-row">
      <div class="kpi"><div class="label">Monthly income</div><div class="value">{budget['monthlyIncome']:,.0f} {currency}</div></div>
      <div class="kpi"><div class="label">Fixed expenses</div><div class="value">{total_expenses:,.0f} {currency}</div></div>
      <div class="kpi"><div class="label">Available</div><div class="value">{(budget['monthlyIncome']-total_expenses):,.0f} {currency}</div></div>
    </div>
    <h2>Zakat</h2>
    <div class="kpi-row">
      <div class="kpi"><div class="label">Nisab value</div><div class="value">{nisab:,.0f} {currency}</div></div>
      <div class="kpi"><div class="label">Zakatable wealth</div><div class="value">{wealth:,.0f} {currency}</div></div>
      <div class="kpi"><div class="label">Above Nisab?</div><div class="value">{'Yes' if wealth>=nisab and nisab>0 else 'No'}</div></div>
    </div>
    <p class="footer-note">Generated by Tawfeer. This report is a planning aid, not financial or religious advice.</p>
    """
    buf = render_pdf(html)
    return send_file(buf, mimetype="application/pdf", as_attachment=True,
                      download_name=f"tawfeer_report_{datetime.now().strftime('%Y%m%d')}.pdf")

# ------------------------------------------------------------------
# Excel export — XlsxWriter, with matplotlib/seaborn chart images embedded
# ------------------------------------------------------------------
@app.route("/api/export/excel")
def export_excel():
    import xlsxwriter
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import seaborn as sns

    cats = load_categories()["categories"]
    txns = all_transactions()
    debts = load_debts()["debts"]
    for d in debts:
        d["remaining"] = _debt_remaining(d)
    budget = load_budget()
    currency = load_settings().get("currency", "MAD")

    buf = BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True})

    navy = "#1F4E78"
    fmt_header = wb.add_format({"bold": True, "bg_color": navy, "font_color": "white", "border": 1, "align": "center", "valign": "vcenter"})
    fmt_cur = wb.add_format({"num_format": f'#,##0 "{currency}"'})
    fmt_bold = wb.add_format({"bold": True})
    fmt_title = wb.add_format({"bold": True, "font_size": 16, "font_color": navy})

    # ---- Goals sheet ----
    ws = wb.add_worksheet("Goals")
    ws.write("A1", "Tawfeer — Savings Goals", fmt_title)
    headers = ["Category", "Target", "Priority", "Saved", "Remaining", "% Complete"]
    for i, h in enumerate(headers):
        ws.write(2, i, h, fmt_header)
    def bal(cid): return sum(t["amount"] for t in txns if t["categoryId"] == cid)
    for r, c in enumerate(sorted(cats, key=lambda x: x["priority"]), start=3):
        b = bal(c["id"])
        ws.write(r, 0, f"{c['icon']} {c['name']}")
        ws.write(r, 1, c["target"], fmt_cur)
        ws.write(r, 2, c["priority"])
        ws.write(r, 3, b, fmt_cur)
        ws.write(r, 4, max(0, c["target"] - b), fmt_cur)
        ws.write(r, 5, (b / c["target"]) if c["target"] else 0, wb.add_format({"num_format": "0%"}))
    ws.set_column(0, 0, 26)
    ws.set_column(1, 5, 14)

    # chart: savings by category (seaborn/matplotlib -> PNG -> embedded image)
    if cats:
        names = [c["name"] for c in cats]
        values = [bal(c["id"]) for c in cats]
        sns.set_theme(style="whitegrid")
        fig, ax = plt.subplots(figsize=(6, 3.2))
        sns.barplot(x=values, y=names, ax=ax, color="#1F4E78")
        ax.set_xlabel(f"Saved ({currency})")
        ax.set_ylabel("")
        ax.set_title("Savings by category")
        fig.tight_layout()
        img_buf = BytesIO()
        fig.savefig(img_buf, format="png", dpi=130)
        plt.close(fig)
        img_buf.seek(0)
        ws.insert_image(2, 7, "savings_by_category.png", {"image_data": img_buf})

    # ---- Transactions sheet ----
    ws2 = wb.add_worksheet("Transactions")
    ws2.write("A1", "All Transactions", fmt_title)
    for i, h in enumerate(["Date", "Month", "Category", "Amount", "Note"]):
        ws2.write(2, i, h, fmt_header)
    cat_names = {c["id"]: c["name"] for c in cats}
    for r, t in enumerate(sorted(txns, key=lambda x: x["date"]), start=3):
        ws2.write(r, 0, t["date"])
        ws2.write(r, 1, t["month"])
        ws2.write(r, 2, cat_names.get(t["categoryId"], "(deleted)"))
        ws2.write(r, 3, t["amount"], fmt_cur)
        ws2.write(r, 4, t.get("note", ""))
    ws2.set_column(0, 0, 12); ws2.set_column(1, 1, 10); ws2.set_column(2, 2, 22); ws2.set_column(3, 3, 14); ws2.set_column(4, 4, 30)

    # chart: monthly net trend
    totals = {}
    for t in txns:
        totals[t["month"]] = totals.get(t["month"], 0) + t["amount"]
    if totals:
        months = sorted(totals.keys())
        fig, ax = plt.subplots(figsize=(7, 3))
        sns.lineplot(x=months, y=[totals[m] for m in months], marker="o", ax=ax, color="#1F4E78")
        ax.set_title("Net saved per month")
        ax.set_ylabel(currency)
        plt.xticks(rotation=45, ha="right")
        fig.tight_layout()
        img_buf2 = BytesIO()
        fig.savefig(img_buf2, format="png", dpi=130)
        plt.close(fig)
        img_buf2.seek(0)
        ws2.insert_image(2, 7, "monthly_trend.png", {"image_data": img_buf2})

    # ---- Debts sheet ----
    ws3 = wb.add_worksheet("Debts")
    ws3.write("A1", "Debts", fmt_title)
    for i, h in enumerate(["Description", "Type", "Original", "Monthly Payment", "Remaining", "% Paid"]):
        ws3.write(2, i, h, fmt_header)
    fmt_pct = wb.add_format({"num_format": "0%"})
    for r, d in enumerate(debts, start=3):
        ws3.write(r, 0, d["description"]); ws3.write(r, 1, d["type"])
        ws3.write(r, 2, d["originalAmount"], fmt_cur); ws3.write(r, 3, d["monthlyPayment"], fmt_cur)
        ws3.write(r, 4, d["remaining"], fmt_cur)
        pct_paid = ((d["originalAmount"] - d["remaining"]) / d["originalAmount"]) if d["originalAmount"] else 0
        ws3.write(r, 5, pct_paid, fmt_pct)
    ws3.set_column(0, 0, 26); ws3.set_column(1, 5, 16)

    # ---- Budget sheet ----
    ws4 = wb.add_worksheet("Budget")
    ws4.write("A1", "Budget", fmt_title)
    ws4.write(2, 0, "Monthly income", fmt_bold); ws4.write(2, 1, budget["monthlyIncome"], fmt_cur)
    for i, h in enumerate(["Expense", "Amount"]):
        ws4.write(4, i, h, fmt_header)
    for r, e in enumerate(budget["expenses"], start=5):
        ws4.write(r, 0, e["name"]); ws4.write(r, 1, e["amount"], fmt_cur)
    ws4.set_column(0, 0, 26); ws4.set_column(1, 1, 16)

    wb.close()
    buf.seek(0)
    return send_file(buf, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      as_attachment=True, download_name=f"tawfeer_export_{datetime.now().strftime('%Y%m%d')}.xlsx")

# ------------------------------------------------------------------
# Excel import — openpyxl, recognizes the original "Family Savings Planner"
# layout (Goals + Monthly Tracker sheets) to migrate data into Tawfeer
# ------------------------------------------------------------------
@app.route("/api/import/excel", methods=["POST"])
def import_excel():
    from openpyxl import load_workbook

    if "file" not in request.files:
        abort(400, "No file uploaded")
    f = request.files["file"]
    try:
        wb = load_workbook(f, data_only=True)
    except Exception as e:
        abort(400, f"Could not read this file as an Excel workbook: {e}")

    summary = {"categoriesCreated": 0, "categoriesMatched": 0, "transactionsCreated": 0, "warnings": []}
    existing = load_categories()
    by_name = {re.sub(r"[^\w\s]", "", c["name"]).strip().lower(): c for c in existing["categories"]}

    def find_header_row(ws, must_contain):
        for row in ws.iter_rows(min_row=1, max_row=10):
            texts = [str(c.value).lower() for c in row if c.value]
            if any(must_contain in t for t in texts):
                return row[0].row
        return None

    # ---- Goals sheet: creates any categories not already present ----
    goals_ws = wb["Goals"] if "Goals" in wb.sheetnames else wb.worksheets[0]
    header_row = find_header_row(goals_ws, "target")
    name_to_id = {}
    if header_row:
        headers = {str(c.value).strip().lower(): c.column for c in goals_ws[header_row] if c.value}
        col_name = headers.get("category")
        col_target = headers.get("target (mad)") or headers.get("target")
        col_priority = headers.get("priority")
        if col_name and col_target:
            for row in goals_ws.iter_rows(min_row=header_row + 1):
                raw_name = row[col_name - 1].value
                if not raw_name or str(raw_name).strip().upper() == "TOTAL":
                    continue
                clean_name = re.sub(r"[^\w\s]", "", str(raw_name)).strip()
                key = clean_name.lower()
                # strip only a leading emoji/icon for the stored display name — keep punctuation like "/"
                icon_match = re.match(r"^(\S+)\s+(.*)$", str(raw_name).strip())
                if icon_match and not icon_match.group(1)[0].isalnum():
                    display_name = icon_match.group(2).strip()
                else:
                    display_name = str(raw_name).strip()
                target_val = row[col_target - 1].value or 0
                if not isinstance(target_val, (int, float)):
                    continue
                if key in by_name:
                    cat = by_name[key]
                    summary["categoriesMatched"] += 1
                else:
                    icon = icon_match.group(1) if icon_match and not icon_match.group(1)[0].isalnum() else "💰"
                    priority_val = row[col_priority - 1].value if col_priority else (len(existing["categories"]) + 1)
                    cat = {
                        "id": new_id("c"), "icon": icon, "name": display_name,
                        "target": float(target_val), "priority": int(priority_val) if isinstance(priority_val, (int, float)) else 1,
                        "pinned": False, "alertThreshold": 90, "recurring": False, "cycleStart": None,
                    }
                    existing["categories"].append(cat)
                    by_name[key] = cat
                    summary["categoriesCreated"] += 1
                name_to_id[key] = cat["id"]
                # also index by the raw column header text seen in Monthly Tracker (may include emoji)
        else:
            summary["warnings"].append("Couldn't find Category/Target columns on the Goals sheet — no categories imported from it.")
    save_categories(existing)

    # ---- Monthly Tracker sheet: creates transactions ----
    if "Monthly Tracker" in wb.sheetnames:
        mt = wb["Monthly Tracker"]
        header_row = find_header_row(mt, "month") or 1
        headers_row_cells = mt[header_row]
        col_month = None
        col_categories = {}  # column index -> category id
        for c in headers_row_cells:
            if not c.value:
                continue
            text = str(c.value).strip()
            low = text.lower()
            if low == "month":
                col_month = c.column
                continue
            clean = re.sub(r"[^\w\s]", "", text).strip().lower()
            if clean in name_to_id:
                col_categories[c.column] = name_to_id[clean]
            elif clean in by_name:
                col_categories[c.column] = by_name[clean]["id"]

        if col_month and col_categories:
            month_re = re.compile(r"^[A-Za-z]{3}-\d{4}$")
            for row in mt.iter_rows(min_row=header_row + 1):
                month_cell = row[col_month - 1].value
                if not month_cell or str(month_cell).strip().upper() == "TOTAL":
                    continue
                month_str = str(month_cell).strip()
                if month_re.match(month_str):
                    mon_abbr, year = month_str.split("-")
                    months_map = {"Jan":"01","Feb":"02","Mar":"03","Apr":"04","May":"05","Jun":"06",
                                  "Jul":"07","Aug":"08","Sep":"09","Oct":"10","Nov":"11","Dec":"12"}
                    if mon_abbr not in months_map:
                        continue
                    date_str = f"{year}-{months_map[mon_abbr]}-01"
                else:
                    continue
                for col_idx, cat_id in col_categories.items():
                    val = row[col_idx - 1].value
                    if isinstance(val, (int, float)) and val != 0:
                        mk = month_key_from_date(date_str)
                        m = load_month(mk)
                        m["transactions"].append({
                            "id": new_id("t"), "categoryId": cat_id, "date": date_str,
                            "amount": float(val), "note": "Imported from Excel",
                        })
                        save_month(mk, m)
                        summary["transactionsCreated"] += 1
        else:
            summary["warnings"].append("Couldn't match the Monthly Tracker columns to categories — no transactions imported.")
    else:
        summary["warnings"].append("No 'Monthly Tracker' sheet found — only categories (if any) were imported.")

    return jsonify(summary)


@app.route("/api/loans/<loan_id>/image")
def loan_image(loan_id):
    from PIL import Image, ImageDraw, ImageFont

    FONT_REGULAR = os.path.join(BASE_DIR, "static", "fonts", "DejaVuSans.ttf")
    FONT_BOLD = os.path.join(BASE_DIR, "static", "fonts", "DejaVuSans-Bold.ttf")

    loan = _get_loan(loan_id)
    remaining = _loan_remaining(loan)
    repaid = loan["principal"] - remaining
    pct = int(round((repaid / loan["principal"]) * 100)) if loan["principal"] else 0

    W, H = 900, 500
    img = Image.new("RGB", (W, H), "#f4f6f9")
    draw = ImageDraw.Draw(img)

    def font(path, size):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            return ImageFont.load_default()

    bold_xl = font(FONT_BOLD, 34)
    bold_lg = font(FONT_BOLD, 24)
    reg_md = font(FONT_REGULAR, 18)
    reg_sm = font(FONT_REGULAR, 14)

    navy = (31, 78, 120)
    green = (30, 158, 107)
    red = (192, 57, 43)
    gray = (124, 138, 153)

    draw.rectangle([0, 0, W, 110], fill=navy)
    draw.text((36, 30), "Loan Statement", font=bold_xl, fill="white")
    tag = "They owe me" if loan["type"] == "lent" else "I owe them"
    tag_color = green if loan["type"] == "lent" else red
    draw.text((36, 140), f'{loan["person"]}', font=bold_lg, fill=(38, 49, 61))
    draw.text((36, 178), tag, font=reg_md, fill=tag_color)

    draw.text((36, 230), "Original amount", font=reg_sm, fill=gray)
    draw.text((36, 252), f'{loan["principal"]:,.0f} MAD', font=bold_lg, fill=(38, 49, 61))

    draw.text((330, 230), "Repaid", font=reg_sm, fill=gray)
    draw.text((330, 252), f'{repaid:,.0f} MAD', font=bold_lg, fill=green)

    draw.text((620, 230), "Remaining", font=reg_sm, fill=gray)
    draw.text((620, 252), f'{remaining:,.0f} MAD', font=bold_lg, fill=navy)

    # progress bar
    bar_x, bar_y, bar_w, bar_h = 36, 320, W - 72, 22
    draw.rounded_rectangle([bar_x, bar_y, bar_x + bar_w, bar_y + bar_h], radius=11, fill=(227, 232, 238))
    fill_w = int(bar_w * pct / 100)
    if fill_w > 0:
        draw.rounded_rectangle([bar_x, bar_y, bar_x + max(fill_w, bar_h), bar_y + bar_h], radius=11, fill=navy)
    draw.text((bar_x, bar_y + 30), f"{pct}% repaid", font=reg_sm, fill=gray)

    draw.text((36, 400), "Interest-free (Qard Hasan) — no profit is charged on this loan.", font=reg_sm, fill=gray)
    draw.text((36, 425), f'Date: {loan["date"]}', font=reg_sm, fill=gray)
    if loan.get("note"):
        draw.text((36, 450), f'Note: {loan["note"]}', font=reg_sm, fill=gray)

    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    fname = f"loan_{loan['person'].replace(' ', '_')}_{loan_id}.png"
    return send_file(buf, mimetype="image/png", as_attachment=True, download_name=fname)

if __name__ == "__main__":
    app.run(debug=True, port=5050)
