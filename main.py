import os, json, hmac, hashlib, time, secrets, mimetypes, logging, re, math, random
import subprocess
import asyncio
import tempfile
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List
from urllib.parse import urlparse
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Request, HTTPException, Response
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse
from fastapi.responses import RedirectResponse, HTMLResponse
import httpx
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
import aiofiles
from pathlib import Path

# --- Config / env ---
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8080")
DOMAIN          = os.environ.get("DOMAIN", "localhost")
COOKIE_DOMAIN   = os.environ.get("COOKIE_DOMAIN", "")
SESSION_TTL     = int(os.environ.get("SESSION_TTL_SECONDS", "300"))
SESSION_COOKIE  = "msgdrop_sess"
UI_COOKIE       = "session-ok"
DATA_DIR        = Path(os.environ.get("DATA_DIR", "/data"))
BLOB_DIR        = DATA_DIR / "blob"
DB_PATH         = DATA_DIR / "messages.db"

ALLOW_EXTERNAL_FETCH = os.environ.get("ALLOW_EXTERNAL_FETCH", "false").lower() == "true"
def _load_google_maps_key():
    # 1) Check env var first (for local dev)
    key = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    if key:
        return key
    # 2) Read from file on persistent volume (production)
    keyfile = DATA_DIR / ".google_maps_key"
    try:
        if keyfile.exists():
            return keyfile.read_text().strip()
    except Exception:
        pass
    return ""
GOOGLE_MAPS_API_KEY = _load_google_maps_key()

MSGDROP_SECRET_JSON = os.environ.get("MSGDROP_SECRET_JSON", "")
try:
    _cfg = json.loads(MSGDROP_SECRET_JSON) if MSGDROP_SECRET_JSON else {}
except Exception:
    _cfg = {}
TWILIO_ACCOUNT_SID = _cfg.get("account_sid", "")
TWILIO_AUTH_TOKEN = _cfg.get("auth_token", "")
TWILIO_FROM_NUMBER = _cfg.get("from_number") or _cfg.get("from", "")
NOTIFY_NUMBERS = _cfg.get("notify_numbers") or _cfg.get("notify") or _cfg.get("to_numbers") or []
if isinstance(NOTIFY_NUMBERS, str):
    NOTIFY_NUMBERS = [NOTIFY_NUMBERS]
EDGE_AUTH_TOKEN = _cfg.get("edgeAuthToken", "")

UNLOCK_CODE_HASH = os.environ.get("UNLOCK_CODE_HASH", "")
UNLOCK_CODE      = os.environ.get("UNLOCK_CODE", "")

CAMERA_STREAM_URL = "https://cam.efive.org/api/reolink_e1_zoom"

TIKTOK_VIDEO_ID_PATTERN = re.compile(r'/video/(\d+)')
_tiktok_video_cache = {}
_TIKTOK_CACHE_TTL = timedelta(minutes=30)

def _clean_tiktok_video_cache():
    now = datetime.now()
    expired = [k for k, v in _tiktok_video_cache.items() if now - v['timestamp'] > _TIKTOK_CACHE_TTL]
    for k in expired:
        del _tiktok_video_cache[k]

SESSION_SIGN_KEY = os.environ.get("SESSION_SIGN_KEY")
if not SESSION_SIGN_KEY:
    keyfile = DATA_DIR / ".sesskey"
    keyfile.parent.mkdir(parents=True, exist_ok=True)
    if keyfile.exists():
        SESSION_SIGN_KEY = keyfile.read_text().strip()
    else:
        SESSION_SIGN_KEY = secrets.token_hex(32)
        keyfile.write_text(SESSION_SIGN_KEY)
SESSION_SIGN_KEY_BYTES = SESSION_SIGN_KEY.encode("utf-8")

# --- App & DB ---
app = FastAPI(title="msgdrop-mono")

@app.middleware("http")
async def add_cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.endswith(('.js', '.css', '.html')) or path in ('/', '/msgdrop', '/msgdrop/'):
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response

engine: Engine = create_engine(f"sqlite:///{DB_PATH}", future=True)
BLOB_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with engine.begin() as conn:
        conn.exec_driver_sql("""
        create table if not exists messages(
            id text primary key,
            drop_id text not null,
            seq integer not null,
            ts integer not null,
            created_at integer not null,
            updated_at integer not null,
            user text,
            client_id text,
            message_type text default 'text',
            text text,
            blob_id text,
            mime text,
            reactions text default '{}',
            gif_url text,
            gif_preview text,
            gif_width integer default 0,
            gif_height integer default 0,
            image_url text,
            image_thumb text,
            reply_to_seq integer,
            delivered_at integer,
            read_at integer,
            audio_duration integer default 0
        );
        """)
        
        migrations = [
            "ALTER TABLE messages ADD COLUMN reply_to_seq integer",
            "ALTER TABLE messages ADD COLUMN delivered_at integer",
            "ALTER TABLE messages ADD COLUMN read_at integer",
            "ALTER TABLE messages ADD COLUMN audio_duration integer default 0",
        ]
        for m in migrations:
            try:
                conn.exec_driver_sql(m)
            except Exception:
                pass
        
        conn.exec_driver_sql("""
        create table if not exists sessions(
            id text primary key,
            exp integer not null
        );
        """)
        conn.exec_driver_sql("""
        create table if not exists streaks(
            drop_id text primary key,
            current_streak integer not null default 0,
            last_m_post text,
            last_e_post text,
            last_update_date text,
            updated_at integer not null
        );
        """)
        conn.exec_driver_sql("""
        create table if not exists geo_games(
            id text primary key,
            drop_id text not null,
            started_by text not null,
            started_at integer not null,
            ended_at integer,
            status text not null default 'active',
            locations text not null,
            e_total_score integer default 0,
            m_total_score integer default 0,
            winner text
        );
        """)
        conn.exec_driver_sql("""
        create table if not exists geo_rounds(
            id integer primary key autoincrement,
            game_id text not null,
            round_num integer not null,
            lat real not null,
            lng real not null,
            country text,
            location_name text,
            e_guess_lat real, e_guess_lng real, e_distance_km real, e_score integer, e_guessed_at integer,
            m_guess_lat real, m_guess_lng real, m_distance_km real, m_score integer, m_guessed_at integer,
            revealed_at integer
        );
        """)

init_db()

# --- GeoGuessr utilities ---
def haversine(lat1, lng1, lat2, lng2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))

def geo_score(distance_km):
    return max(0, round(5000 * math.exp(-distance_km / 1500)))

GEO_LOCATIONS = [
    # EUROPE
    {"lat": 48.8584, "lng": 2.2945, "country": "France", "name": "Eiffel Tower, Paris"},
    {"lat": 41.9029, "lng": 12.4534, "country": "Italy", "name": "Vatican City, Rome"},
    {"lat": 51.5014, "lng": -0.1419, "country": "UK", "name": "Big Ben, London"},
    {"lat": 52.3676, "lng": 4.9041, "country": "Netherlands", "name": "Amsterdam Canals"},
    {"lat": 40.4168, "lng": -3.7038, "country": "Spain", "name": "Puerta del Sol, Madrid"},
    {"lat": 37.9715, "lng": 23.7267, "country": "Greece", "name": "Acropolis, Athens"},
    {"lat": 48.2082, "lng": 16.3738, "country": "Austria", "name": "St. Stephen's, Vienna"},
    {"lat": 41.0082, "lng": 28.9784, "country": "Turkey", "name": "Hagia Sophia, Istanbul"},
    {"lat": 59.3293, "lng": 18.0686, "country": "Sweden", "name": "Gamla Stan, Stockholm"},
    {"lat": 55.6761, "lng": 12.5683, "country": "Denmark", "name": "Nyhavn, Copenhagen"},
    {"lat": 50.0755, "lng": 14.4378, "country": "Czech Republic", "name": "Old Town Square, Prague"},
    {"lat": 47.4979, "lng": 19.0402, "country": "Hungary", "name": "Chain Bridge, Budapest"},
    {"lat": 52.5200, "lng": 13.4050, "country": "Germany", "name": "Brandenburg Gate, Berlin"},
    {"lat": 48.1351, "lng": 11.5820, "country": "Germany", "name": "Marienplatz, Munich"},
    {"lat": 45.4408, "lng": 12.3155, "country": "Italy", "name": "St. Mark's Square, Venice"},
    {"lat": 43.7696, "lng": 11.2558, "country": "Italy", "name": "Ponte Vecchio, Florence"},
    {"lat": 41.3851, "lng": 2.1734, "country": "Spain", "name": "La Rambla, Barcelona"},
    {"lat": 38.7223, "lng": -9.1393, "country": "Portugal", "name": "Belem Tower, Lisbon"},
    {"lat": 53.3498, "lng": -6.2603, "country": "Ireland", "name": "Temple Bar, Dublin"},
    {"lat": 55.9533, "lng": -3.1883, "country": "UK", "name": "Royal Mile, Edinburgh"},
    {"lat": 60.1699, "lng": 24.9384, "country": "Finland", "name": "Senate Square, Helsinki"},
    {"lat": 59.9139, "lng": 10.7522, "country": "Norway", "name": "Karl Johans Gate, Oslo"},
    {"lat": 46.9480, "lng": 7.4474, "country": "Switzerland", "name": "Old Town, Bern"},
    {"lat": 47.3769, "lng": 8.5417, "country": "Switzerland", "name": "Bahnhofstrasse, Zurich"},
    {"lat": 43.2965, "lng": 5.3698, "country": "France", "name": "Old Port, Marseille"},
    {"lat": 45.7640, "lng": 4.8357, "country": "France", "name": "Place Bellecour, Lyon"},
    {"lat": 51.2194, "lng": 4.4025, "country": "Belgium", "name": "Grote Markt, Antwerp"},
    {"lat": 50.8503, "lng": 4.3517, "country": "Belgium", "name": "Grand Place, Brussels"},
    {"lat": 44.4268, "lng": 26.1025, "country": "Romania", "name": "Old Town, Bucharest"},
    {"lat": 42.6977, "lng": 23.3219, "country": "Bulgaria", "name": "Alexander Nevsky, Sofia"},
    {"lat": 45.8150, "lng": 15.9819, "country": "Croatia", "name": "Ban Jelacic Square, Zagreb"},
    {"lat": 43.5081, "lng": 16.4402, "country": "Croatia", "name": "Diocletian's Palace, Split"},
    {"lat": 42.4304, "lng": 19.2594, "country": "Montenegro", "name": "Old Town, Kotor"},
    {"lat": 64.1466, "lng": -21.9426, "country": "Iceland", "name": "Hallgrimskirkja, Reykjavik"},
    {"lat": 36.7213, "lng": -4.4214, "country": "Spain", "name": "Malaga Port, Malaga"},
    # AMERICAS
    {"lat": 40.7580, "lng": -73.9855, "country": "USA", "name": "Times Square, New York"},
    {"lat": 37.7749, "lng": -122.4194, "country": "USA", "name": "Fisherman's Wharf, San Francisco"},
    {"lat": 34.0522, "lng": -118.2437, "country": "USA", "name": "Hollywood Blvd, Los Angeles"},
    {"lat": 41.8781, "lng": -87.6298, "country": "USA", "name": "Michigan Avenue, Chicago"},
    {"lat": 25.7617, "lng": -80.1918, "country": "USA", "name": "South Beach, Miami"},
    {"lat": 36.1699, "lng": -115.1398, "country": "USA", "name": "The Strip, Las Vegas"},
    {"lat": 47.6062, "lng": -122.3321, "country": "USA", "name": "Pike Place Market, Seattle"},
    {"lat": 38.8977, "lng": -77.0365, "country": "USA", "name": "White House, Washington DC"},
    {"lat": 29.9511, "lng": -90.0715, "country": "USA", "name": "French Quarter, New Orleans"},
    {"lat": 42.3601, "lng": -71.0589, "country": "USA", "name": "Faneuil Hall, Boston"},
    {"lat": 39.7392, "lng": -104.9903, "country": "USA", "name": "16th Street Mall, Denver"},
    {"lat": 30.2672, "lng": -97.7431, "country": "USA", "name": "6th Street, Austin"},
    {"lat": 32.7157, "lng": -117.1611, "country": "USA", "name": "Gaslamp Quarter, San Diego"},
    {"lat": 45.5152, "lng": -122.6784, "country": "USA", "name": "Pioneer Square, Portland"},
    {"lat": 21.2769, "lng": -157.8268, "country": "USA", "name": "Waikiki Beach, Hawaii"},
    {"lat": 43.6532, "lng": -79.3832, "country": "Canada", "name": "CN Tower, Toronto"},
    {"lat": 49.2827, "lng": -123.1207, "country": "Canada", "name": "Stanley Park, Vancouver"},
    {"lat": 45.5017, "lng": -73.5673, "country": "Canada", "name": "Old Montreal, Montreal"},
    {"lat": -22.9068, "lng": -43.1729, "country": "Brazil", "name": "Copacabana, Rio de Janeiro"},
    {"lat": -23.5505, "lng": -46.6333, "country": "Brazil", "name": "Paulista Avenue, Sao Paulo"},
    {"lat": 19.4326, "lng": -99.1332, "country": "Mexico", "name": "Zocalo, Mexico City"},
    {"lat": 20.6296, "lng": -87.0739, "country": "Mexico", "name": "Tulum Beach, Tulum"},
    {"lat": -33.4489, "lng": -70.6693, "country": "Chile", "name": "Plaza de Armas, Santiago"},
    {"lat": -34.6037, "lng": -58.3816, "country": "Argentina", "name": "La Boca, Buenos Aires"},
    {"lat": -12.0464, "lng": -77.0428, "country": "Peru", "name": "Plaza Mayor, Lima"},
    {"lat": -0.1807, "lng": -78.4678, "country": "Ecuador", "name": "Old Town, Quito"},
    {"lat": 4.7110, "lng": -74.0721, "country": "Colombia", "name": "La Candelaria, Bogota"},
    {"lat": 18.4655, "lng": -66.1057, "country": "Puerto Rico", "name": "Old San Juan"},
    {"lat": 23.1136, "lng": -82.3666, "country": "Cuba", "name": "Malecon, Havana"},
    # ASIA
    {"lat": 35.6762, "lng": 139.6503, "country": "Japan", "name": "Shibuya Crossing, Tokyo"},
    {"lat": 34.9686, "lng": 135.7728, "country": "Japan", "name": "Fushimi Inari, Kyoto"},
    {"lat": 34.6937, "lng": 135.5023, "country": "Japan", "name": "Dotonbori, Osaka"},
    {"lat": 37.5665, "lng": 126.9780, "country": "South Korea", "name": "Gwanghwamun, Seoul"},
    {"lat": 35.1796, "lng": 129.0756, "country": "South Korea", "name": "Haeundae Beach, Busan"},
    {"lat": 1.3521, "lng": 103.8198, "country": "Singapore", "name": "Marina Bay, Singapore"},
    {"lat": 13.7563, "lng": 100.5018, "country": "Thailand", "name": "Grand Palace, Bangkok"},
    {"lat": 7.8804, "lng": 98.3923, "country": "Thailand", "name": "Patong Beach, Phuket"},
    {"lat": 22.3193, "lng": 114.1694, "country": "Hong Kong", "name": "Victoria Peak, Hong Kong"},
    {"lat": 25.0330, "lng": 121.5654, "country": "Taiwan", "name": "Taipei 101, Taipei"},
    {"lat": 14.5995, "lng": 120.9842, "country": "Philippines", "name": "Intramuros, Manila"},
    {"lat": 21.0285, "lng": 105.8542, "country": "Vietnam", "name": "Old Quarter, Hanoi"},
    {"lat": 10.8231, "lng": 106.6297, "country": "Vietnam", "name": "Ben Thanh Market, Ho Chi Minh"},
    {"lat": 3.1390, "lng": 101.6869, "country": "Malaysia", "name": "Petronas Towers, Kuala Lumpur"},
    {"lat": -8.4095, "lng": 115.1889, "country": "Indonesia", "name": "Tanah Lot, Bali"},
    {"lat": 28.6139, "lng": 77.2090, "country": "India", "name": "India Gate, New Delhi"},
    {"lat": 19.0760, "lng": 72.8777, "country": "India", "name": "Gateway of India, Mumbai"},
    {"lat": 27.1751, "lng": 78.0421, "country": "India", "name": "Taj Mahal, Agra"},
    {"lat": 39.9042, "lng": 116.4074, "country": "China", "name": "Tiananmen Square, Beijing"},
    {"lat": 31.2304, "lng": 121.4737, "country": "China", "name": "The Bund, Shanghai"},
    {"lat": 25.1972, "lng": 55.2744, "country": "UAE", "name": "Burj Khalifa, Dubai"},
    {"lat": 24.4539, "lng": 54.3773, "country": "UAE", "name": "Sheikh Zayed Mosque, Abu Dhabi"},
    {"lat": 31.7683, "lng": 35.2137, "country": "Israel", "name": "Western Wall, Jerusalem"},
    {"lat": 32.0853, "lng": 34.7818, "country": "Israel", "name": "Jaffa Port, Tel Aviv"},
    {"lat": 41.7151, "lng": 44.8271, "country": "Georgia", "name": "Old Town, Tbilisi"},
    {"lat": 40.4093, "lng": 49.8671, "country": "Azerbaijan", "name": "Flame Towers, Baku"},
    {"lat": 27.7172, "lng": 85.3240, "country": "Nepal", "name": "Durbar Square, Kathmandu"},
    {"lat": 6.9271, "lng": 79.8612, "country": "Sri Lanka", "name": "Galle Face Green, Colombo"},
    # OCEANIA
    {"lat": -33.8688, "lng": 151.2093, "country": "Australia", "name": "Sydney Opera House, Sydney"},
    {"lat": -37.8136, "lng": 144.9631, "country": "Australia", "name": "Federation Square, Melbourne"},
    {"lat": -27.4698, "lng": 153.0251, "country": "Australia", "name": "South Bank, Brisbane"},
    {"lat": -36.8485, "lng": 174.7633, "country": "New Zealand", "name": "Sky Tower, Auckland"},
    {"lat": -41.2924, "lng": 174.7787, "country": "New Zealand", "name": "Cuba Street, Wellington"},
    # AFRICA
    {"lat": -33.9249, "lng": 18.4241, "country": "South Africa", "name": "V&A Waterfront, Cape Town"},
    {"lat": -26.2041, "lng": 28.0473, "country": "South Africa", "name": "Nelson Mandela Square, Johannesburg"},
    {"lat": 30.0444, "lng": 31.2357, "country": "Egypt", "name": "Tahrir Square, Cairo"},
    {"lat": 29.9773, "lng": 31.1325, "country": "Egypt", "name": "Great Pyramids, Giza"},
    {"lat": -1.2921, "lng": 36.8219, "country": "Kenya", "name": "Kenyatta Avenue, Nairobi"},
    {"lat": 33.9716, "lng": -6.8498, "country": "Morocco", "name": "Hassan Tower, Rabat"},
    {"lat": 33.5731, "lng": -7.5898, "country": "Morocco", "name": "Hassan II Mosque, Casablanca"},
    {"lat": 31.6295, "lng": -7.9811, "country": "Morocco", "name": "Jemaa el-Fnaa, Marrakech"},
    {"lat": 36.8065, "lng": 10.1815, "country": "Tunisia", "name": "Medina, Tunis"},
    {"lat": 6.5244, "lng": 3.3792, "country": "Nigeria", "name": "Victoria Island, Lagos"},
    {"lat": -3.3869, "lng": 29.3609, "country": "Burundi", "name": "Independence Square, Bujumbura"},
    # MIDDLE EAST / CENTRAL ASIA
    {"lat": 33.5138, "lng": 36.2765, "country": "Syria", "name": "Old City, Damascus"},
    {"lat": 33.8938, "lng": 35.5018, "country": "Lebanon", "name": "Corniche, Beirut"},
    {"lat": 40.1792, "lng": 44.4991, "country": "Armenia", "name": "Republic Square, Yerevan"},
    {"lat": 41.2995, "lng": 69.2401, "country": "Uzbekistan", "name": "Chorsu Bazaar, Tashkent"},
    {"lat": 39.6693, "lng": 66.9597, "country": "Uzbekistan", "name": "Registan Square, Samarkand"},
    # RUSSIA
    {"lat": 55.7558, "lng": 37.6173, "country": "Russia", "name": "Red Square, Moscow"},
    {"lat": 59.9343, "lng": 30.3351, "country": "Russia", "name": "Nevsky Prospect, St. Petersburg"},
    # CARIBBEAN / ISLANDS
    {"lat": 18.2208, "lng": -66.5901, "country": "Puerto Rico", "name": "Rincon Beach"},
    {"lat": 25.0343, "lng": -77.3963, "country": "Bahamas", "name": "Bay Street, Nassau"},
    {"lat": 18.4861, "lng": -69.9312, "country": "Dominican Republic", "name": "Colonial Zone, Santo Domingo"},
    # ADDITIONAL EUROPE
    {"lat": 37.9838, "lng": 23.7275, "country": "Greece", "name": "Plaka District, Athens"},
    {"lat": 35.8989, "lng": 14.5146, "country": "Malta", "name": "Valletta Waterfront, Malta"},
    {"lat": 43.7384, "lng": 7.4246, "country": "Monaco", "name": "Monte Carlo Casino"},
    {"lat": 43.9424, "lng": 12.4578, "country": "San Marino", "name": "Guaita Tower, San Marino"},
    {"lat": 42.5063, "lng": 1.5218, "country": "Andorra", "name": "Andorra la Vella"},
    {"lat": 49.6117, "lng": 6.1300, "country": "Luxembourg", "name": "Place d'Armes, Luxembourg City"},
    # ADDITIONAL AMERICAS
    {"lat": 36.1147, "lng": -115.1728, "country": "USA", "name": "Fremont Street, Las Vegas"},
    {"lat": 33.7490, "lng": -84.3880, "country": "USA", "name": "Centennial Park, Atlanta"},
    {"lat": 35.2271, "lng": -80.8431, "country": "USA", "name": "Uptown, Charlotte"},
    {"lat": 39.0997, "lng": -94.5786, "country": "USA", "name": "Country Club Plaza, Kansas City"},
    {"lat": 44.9778, "lng": -93.2650, "country": "USA", "name": "Nicollet Mall, Minneapolis"},
    {"lat": 29.4241, "lng": -98.4936, "country": "USA", "name": "River Walk, San Antonio"},
    {"lat": 35.1495, "lng": -90.0490, "country": "USA", "name": "Beale Street, Memphis"},
    {"lat": 36.1627, "lng": -86.7816, "country": "USA", "name": "Broadway, Nashville"},
    # ADDITIONAL ASIA
    {"lat": 35.0116, "lng": 135.7681, "country": "Japan", "name": "Kinkaku-ji, Kyoto"},
    {"lat": 43.0621, "lng": 141.3544, "country": "Japan", "name": "Odori Park, Sapporo"},
    {"lat": 22.2783, "lng": 114.1747, "country": "Hong Kong", "name": "Tsim Sha Tsui Promenade"},
    {"lat": 13.4125, "lng": 103.8670, "country": "Cambodia", "name": "Angkor Wat, Siem Reap"},
    {"lat": 16.8661, "lng": 96.1951, "country": "Myanmar", "name": "Shwedagon Pagoda, Yangon"},
    {"lat": 47.9184, "lng": 106.9177, "country": "Mongolia", "name": "Sukhbaatar Square, Ulaanbaatar"},
]

# ─────────────────────────────────────────────────────────────────────────────
# PENDING CALL STATE
# When a caller sends op='incoming', we store it here so that if the callee
# opens the app *after* the call was initiated they still see the incoming call.
# Structure: { drop_id: { op, from, peerId, ts } }
# Cleared when op='ended', 'declined', or 'answered', or after 90 seconds.
# ─────────────────────────────────────────────────────────────────────────────
_pending_calls: Dict[str, Dict[str, Any]] = {}
_PENDING_CALL_TTL_S = 90  # seconds before we auto-expire a pending call

def _store_pending_call(drop_id: str, payload: Dict[str, Any]):
    _pending_calls[drop_id] = {**payload, "ts": time.time()}
    logger.info(f"[PendingCall] Stored call for drop={drop_id} from={payload.get('from')}")

def _clear_pending_call(drop_id: str):
    if drop_id in _pending_calls:
        del _pending_calls[drop_id]
        logger.info(f"[PendingCall] Cleared call for drop={drop_id}")

def _get_pending_call(drop_id: str) -> Optional[Dict[str, Any]]:
    call = _pending_calls.get(drop_id)
    if call and time.time() - call.get("ts", 0) > _PENDING_CALL_TTL_S:
        _clear_pending_call(drop_id)
        return None
    return call

# --- Twilio notifications ---
_last_notify: Dict[str, int] = {}

def _should_notify(kind: str, drop_id: str, window_sec: int = 60) -> bool:
    key = f"{kind}:{drop_id}"
    now = int(time.time())
    last = _last_notify.get(key, 0)
    if now - last < window_sec:
        return False
    _last_notify[key] = now
    return True

def notify(text: str):
    logger.info(f"[notify] {text}")
    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN or not TWILIO_FROM_NUMBER:
        logger.warning("[notify] Twilio not configured, skipping SMS")
        return
    if not NOTIFY_NUMBERS:
        logger.warning("[notify] No notify numbers configured")
        return
    try:
        from twilio.rest import Client
        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        for to_number in NOTIFY_NUMBERS:
            try:
                message = client.messages.create(
                    body=text,
                    from_=TWILIO_FROM_NUMBER,
                    to=to_number
                )
                logger.info(f"[notify] SMS sent to {to_number}: {message.sid}")
            except Exception as e:
                logger.error(f"[notify] Failed to send SMS to {to_number}: {e}")
    except Exception as e:
        logger.error(f"[notify] Twilio error: {e}")

# --- Cookies / session ---
def b64url(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")

def sign(payload: bytes) -> bytes:
    return hmac.new(SESSION_SIGN_KEY_BYTES, payload, hashlib.sha256).digest()

def _generate_token() -> str:
    exp = int(time.time()) + SESSION_TTL
    payload = json.dumps({"exp": exp}, separators=(",", ":")).encode("utf-8")
    sig = sign(payload)
    return b64url(payload + b"." + sig)

def issue_cookies() -> List[str]:
    token = _generate_token()
    parts = [f'{SESSION_COOKIE}="{token}"', "HttpOnly", "Secure", "Path=/", "SameSite=Lax"]
    if COOKIE_DOMAIN: parts.append(f"Domain={COOKIE_DOMAIN}")
    sess_cookie = "; ".join(parts)
    ui_parts = [f"{UI_COOKIE}={token}", "Secure", "Path=/", "SameSite=Lax"]
    if COOKIE_DOMAIN: ui_parts.append(f"Domain={COOKIE_DOMAIN}")
    ui_cookie = "; ".join(ui_parts)
    return [sess_cookie, ui_cookie]

def _verify_token(token: str) -> bool:
    import base64
    try:
        raw = token + "==="
        blob = base64.urlsafe_b64decode(raw)
        dot = blob.find(b".")
        if dot <= 0:
            return False
        payload, mac = blob[:dot], blob[dot+1:]
        if not hmac.compare_digest(sign(payload), mac):
            return False
        data = json.loads(payload.decode("utf-8"))
        exp_time = int(data.get("exp", 0))
        current_time = int(time.time())
        if current_time > exp_time:
            return False
        return True
    except Exception as e:
        logger.debug(f"Token verification error: {e}")
        return False

def require_session(req: Request):
    c = req.cookies.get(SESSION_COOKIE)
    if not c: raise HTTPException(401, "no session")
    if not _verify_token(c):
        raise HTTPException(401, "bad session")

# --- Health ---
@app.get("/api/health")
def health():
    return {"ok": True, "service": "msgdrop-rest"}

# --- Unlock ---
class UnlockBody(BaseModel):
    code: str

def verify_code(code: str) -> bool:
    if UNLOCK_CODE_HASH:
        got = hashlib.sha256(code.encode("utf-8")).hexdigest()
        return hmac.compare_digest(got, UNLOCK_CODE_HASH)
    if UNLOCK_CODE:
        return hmac.compare_digest(code, UNLOCK_CODE)
    return False

unlock_attempts: Dict[str, List[int]] = {}

def _set_session_cookies(response: Response, token: str):
    response.set_cookie(
        key=SESSION_COOKIE, value=token, max_age=SESSION_TTL,
        httponly=True, secure=True, samesite="lax",
        domain=(COOKIE_DOMAIN or None), path="/",
    )
    response.set_cookie(
        key=UI_COOKIE, value=token, max_age=SESSION_TTL,
        httponly=False, secure=True, samesite="lax",
        domain=(COOKIE_DOMAIN or None), path="/",
    )

@app.post("/api/unlock")
def unlock(body: UnlockBody, req: Request, response: Response):
    client_ip = req.client.host if getattr(req, "client", None) else "unknown"
    now = int(time.time())
    attempts = unlock_attempts.get(client_ip, [])
    attempts = [t for t in attempts if now - t < 300]
    if len(attempts) >= 5:
        raise HTTPException(429, "Too many attempts. Try again in 5 minutes.")
    code = (body.code or "").strip()
    if not (len(code) == 4 and code.isdigit()):
        attempts.append(now)
        unlock_attempts[client_ip] = attempts
        raise HTTPException(400, "PIN must be 4 digits")
    if not verify_code(code):
        attempts.append(now)
        unlock_attempts[client_ip] = attempts
        raise HTTPException(401, "invalid code")
    unlock_attempts.pop(client_ip, None)
    token = _generate_token()
    _set_session_cookies(response, token)
    return {"success": True}

# --- Chat APIs ---
@app.get("/api/chat/{drop_id}")
def list_messages(drop_id: str, limit: int = 200, before: Optional[int] = None, req: Request = None):
    require_session(req)
    sql = "select * from messages where drop_id=:d"
    params = {"d": drop_id}
    if before:
        sql += " and ts < :b"; params["b"] = before
    sql += " order by seq desc limit :n"; params["n"] = max(1, min(500, limit))
    with engine.begin() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
        max_seq = conn.execute(text("select coalesce(max(seq),0) as v from messages where drop_id=:d"), {"d": drop_id}).scalar()
    rows = list(reversed(rows))
    out = []
    images = []
    for r in rows:
        o = dict(r)
        msg = {
            "message": o.get("text"),
            "seq": o.get("seq"),
            "createdAt": o.get("created_at"),
            "updatedAt": o.get("updated_at"),
            "user": o.get("user"),
            "clientId": o.get("client_id"),
            "messageType": o.get("message_type"),
            "reactions": json.loads(o.get("reactions") or "{}"),
            "gifUrl": o.get("gif_url"),
            "gifPreview": o.get("gif_preview"),
            "gifWidth": o.get("gif_width"),
            "gifHeight": o.get("gif_height"),
            "imageUrl": o.get("image_url"),
            "imageThumb": o.get("image_thumb"),
            "replyToSeq": o.get("reply_to_seq"),
            "deliveredAt": o.get("delivered_at"),
            "readAt": o.get("read_at"),
            "audioDuration": o.get("audio_duration"),
        }
        if o.get("blob_id"):
            msg["img"] = f"/blob/{o['blob_id']}"
            if o.get("message_type") == "audio":
                msg["audioUrl"] = f"/blob/{o['blob_id']}"
            else:
                images.append({
                    "imageId": o["blob_id"],
                    "mime": o.get("mime"),
                    "originalUrl": msg["img"],
                    "thumbUrl": msg["img"],
                    "uploadedAt": o.get("ts"),
                })
        out.append(msg)
    return {"dropId": drop_id, "version": int(max_seq or 0), "messages": out, "images": images}

@app.head("/api/chat/{drop_id}")
def head_messages(drop_id: str, req: Request = None):
    require_session(req)
    return Response(status_code=200)

def cleanup_old_messages(drop_id: str, keep_count: int = 30):
    with engine.begin() as conn:
        threshold_row = conn.execute(text("""
            select seq from (
                select seq from messages 
                where drop_id = :d 
                order by seq desc 
                limit :n
            ) 
            order by seq asc 
            limit 1
        """), {"d": drop_id, "n": keep_count}).mappings().first()
        
        if not threshold_row:
            return 0
        
        threshold_seq = threshold_row["seq"]
        
        old_blobs = conn.execute(text("""
            select blob_id from messages 
            where drop_id = :d and seq < :threshold and blob_id is not null
        """), {"d": drop_id, "threshold": threshold_seq}).fetchall()
        
        result = conn.execute(text("""
            delete from messages 
            where drop_id = :d and seq < :threshold
        """), {"d": drop_id, "threshold": threshold_seq})
        
        for row in old_blobs:
            blob_id = row[0]
            if blob_id:
                blob_path = BLOB_DIR / blob_id
                try:
                    if blob_path.exists():
                        blob_path.unlink()
                except Exception:
                    pass
        
        return result.rowcount

@app.post("/api/chat/{drop_id}")
async def post_message(drop_id: str,
                       text_: Optional[str] = Form(default=None),
                       user: Optional[str] = Form(default=None),
                       audio_duration: Optional[int] = Form(default=None),
                       file: Optional[UploadFile] = File(default=None),
                       req: Request = None):
    require_session(req)
    logger.info(f"[POST] drop={drop_id} user={user}")
    ts = int(time.time() * 1000)
    msg_id = secrets.token_hex(8)
    blob_id, mime = None, None
    gif_url = None
    gif_preview = None
    gif_width = 0
    gif_height = 0
    image_url = None
    image_thumb = None
    message_type = "text"
    reply_to_seq = None
    audio_dur = audio_duration or 0

    ctype = (req.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype == "application/json":
        body = await req.json()
        text_ = body.get("text")
        user = body.get("user") or user
        gif_url = body.get("gifUrl")
        image_url = body.get("imageUrl")
        reply_to_seq = body.get("replyToSeq")
        if gif_url:
            message_type = "gif"
            gif_preview = body.get("gifPreview")
            gif_width = body.get("gifWidth", 0)
            gif_height = body.get("gifHeight", 0)
            title = body.get("title") or "GIF"
            text_ = f"[GIF: {title}]"
        elif image_url:
            message_type = "image"

    if file:
        suffix = Path(file.filename or "").suffix.lower()
        blob_id = secrets.token_hex(12) + suffix
        dest = BLOB_DIR / blob_id
        async with aiofiles.open(dest, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk: break
                await f.write(chunk)
        mime = file.content_type or mimetypes.guess_type(dest.name)[0] or "application/octet-stream"
        
        if mime.startswith("audio/") or suffix in (".m4a", ".webm", ".mp3", ".ogg", ".wav"):
            message_type = "audio"
            audio_url_path = f"/blob/{blob_id}"
            image_url = audio_url_path
            if not text_:
                text_ = "[Voice Message]"
        else:
            message_type = "image"
            image_url = f"/blob/{blob_id}"
            image_thumb = f"/blob/{blob_id}"
            if not text_:
                text_ = "[Image]"

    with engine.begin() as conn:
        row = conn.execute(text("select coalesce(max(seq),0)+1 as next from messages where drop_id=:d"), {"d": drop_id}).mappings().first()
        next_seq = int(row["next"]) if row else 1
        now_ms = ts
        conn.execute(text("""
          insert into messages(id,drop_id,seq,ts,created_at,updated_at,user,client_id,message_type,text,blob_id,mime,reactions,gif_url,gif_preview,gif_width,gif_height,image_url,image_thumb,reply_to_seq,delivered_at,audio_duration)
          values(:id,:d,:seq,:ts,:ca,:ua,:u,:cid,:mt,:tx,:b,:m,:rx,:gurl,:gprev,:gw,:gh,:iurl,:ithumb,:rts,:del,:adur)
        """), {"id": msg_id, "d": drop_id, "seq": next_seq, "ts": ts, "ca": now_ms, "ua": now_ms,
                "u": user, "cid": None, "mt": message_type, "tx": text_, "b": blob_id, "m": mime, "rx": "{}",
                "gurl": gif_url, "gprev": gif_preview, "gw": gif_width, "gh": gif_height, "iurl": image_url, "ithumb": image_thumb,
                "rts": reply_to_seq, "del": now_ms, "adur": audio_dur})

    cleanup_old_messages(drop_id, keep_count=30)

    user_normalized = (user or "").strip() or "E"
    streak_result = update_streak_on_message(drop_id, user_normalized)
    
    if streak_result["changed"]:
        streak_data = get_streak(drop_id)
        await hub.broadcast(drop_id, {"type": "streak", "data": streak_data})
    
    await hub.broadcast(drop_id, {
        "type": "update",
        "message": {
            "id": msg_id, "drop_id": drop_id, "seq": next_seq, "ts": ts, "user": user, "text": text_,
            "blob_id": blob_id, "mime": mime, "img": (f"/blob/{blob_id}" if blob_id else None)
        }
    })

    if (user or "").upper() == "E":
        if message_type == "audio" and _should_notify("audio", drop_id, 60):
            notify("E sent a voice message")
        elif message_type == "text" and _should_notify("msg", drop_id, 60):
            notify("E posted a new message")

    return list_messages(drop_id, req=req)

# --- Message edit/delete/react and image delete ---
from fastapi import Body

@app.patch("/api/chat/{drop_id}")
async def edit_message(drop_id: str, body: Dict[str, Any] = Body(...), req: Request = None):
    require_session(req)
    seq = body.get("seq")
    text_val = body.get("text")
    if seq is None or text_val is None:
        raise HTTPException(400, "seq and text required")
    now_ms = int(time.time() * 1000)
    with engine.begin() as conn:
        conn.execute(text("update messages set text=:t, updated_at=:u where drop_id=:d and seq=:s"),
                     {"t": text_val, "u": now_ms, "d": drop_id, "s": seq})
    await hub.broadcast(drop_id, {"type": "update"})
    return list_messages(drop_id, req=req)

@app.delete("/api/chat/{drop_id}")
async def delete_message(drop_id: str, body: Dict[str, Any] = Body(...), req: Request = None):
    require_session(req)
    seq = body.get("seq")
    if seq is None:
        raise HTTPException(400, "seq required")
    with engine.begin() as conn:
        row = conn.execute(text("select blob_id from messages where drop_id=:d and seq=:s"),
                           {"d": drop_id, "s": seq}).mappings().first()
        if row and row.get("blob_id"):
            try:
                (BLOB_DIR / row["blob_id"]).unlink(missing_ok=True)
            except Exception:
                pass
        conn.execute(text("delete from messages where drop_id=:d and seq=:s"), {"d": drop_id, "s": seq})
    await hub.broadcast(drop_id, {"type": "update"})
    return list_messages(drop_id, req=req)

@app.post("/api/chat/{drop_id}/react")
async def react_message(drop_id: str, body: Dict[str, Any] = Body(...), req: Request = None):
    require_session(req)
    seq = body.get("seq")
    emoji = body.get("emoji")
    op = (body.get("op") or "add").lower()
    if seq is None or not emoji:
        raise HTTPException(400, "seq and emoji required")
    with engine.begin() as conn:
        row = conn.execute(text("select reactions from messages where drop_id=:d and seq=:s"),
                           {"d": drop_id, "s": seq}).mappings().first()
        if not row:
            raise HTTPException(404, "message not found")
        try:
            rx = json.loads(row["reactions"] or "{}")
        except Exception:
            rx = {}
        cur = int(rx.get(emoji, 0))
        if op == "add":
            rx[emoji] = cur + 1
        elif op == "remove":
            rx[emoji] = max(0, cur - 1)
        else:
            raise HTTPException(400, "op must be add/remove")
        conn.execute(text("update messages set reactions=:r where drop_id=:d and seq=:s"),
                     {"r": json.dumps(rx, separators=(",", ":")), "d": drop_id, "s": seq})
    await hub.broadcast(drop_id, {"type": "update"})
    return list_messages(drop_id, req=req)

@app.post("/api/chat/{drop_id}/read")
async def mark_messages_read(drop_id: str, body: Dict[str, Any] = Body(...), req: Request = None):
    require_session(req)
    up_to_seq = body.get("upToSeq")
    reader = body.get("reader")
    if up_to_seq is None or not reader:
        raise HTTPException(400, "upToSeq and reader required")
    now_ms = int(time.time() * 1000)
    with engine.begin() as conn:
        result = conn.execute(text("""
            UPDATE messages SET read_at = :now 
            WHERE drop_id = :d AND seq <= :seq AND user != :reader AND read_at IS NULL
        """), {"now": now_ms, "d": drop_id, "seq": up_to_seq, "reader": reader})
        updated_count = result.rowcount
    if updated_count > 0:
        await hub.broadcast(drop_id, {
            "type": "read_receipt",
            "data": {"upToSeq": up_to_seq, "reader": reader, "readAt": now_ms}
        })
    return {"success": True, "updated": updated_count}

@app.delete("/api/chat/{drop_id}/images/{image_id}")
async def delete_image(drop_id: str, image_id: str, req: Request = None):
    require_session(req)
    with engine.begin() as conn:
        conn.execute(text("delete from messages where drop_id=:d and blob_id=:b"), {"d": drop_id, "b": image_id})
    file_path = BLOB_DIR / image_id
    try:
        if file_path.exists():
            file_path.unlink()
    except Exception as e:
        logger.error(f"[delete_image] Failed to delete file {image_id}: {e}")
    await hub.broadcast(drop_id, {"type": "update"})
    return list_messages(drop_id, req=req)

# --- Streaks ---
from zoneinfo import ZoneInfo
import datetime as _dt

NY_TZ = ZoneInfo("America/New_York")

def get_est_today() -> str:
    return _dt.datetime.now(NY_TZ).strftime("%Y-%m-%d")

def get_est_yesterday() -> str:
    return (_dt.datetime.now(NY_TZ) - _dt.timedelta(days=1)).strftime("%Y-%m-%d")

def update_streak_on_message(drop_id: str, user: str) -> Dict[str, Any]:
    today = get_est_today()
    yesterday = get_est_yesterday()
    now_ts = int(time.time() * 1000)
    
    with engine.begin() as conn:
        row = conn.execute(text("SELECT * FROM streaks WHERE drop_id = :d"), {"d": drop_id}).mappings().first()
        
        if row:
            current_streak = row["current_streak"] or 0
            last_completed = row.get("last_update_date")
            m_last = row.get("last_m_post")
            e_last = row.get("last_e_post")
        else:
            current_streak = 0
            last_completed = None
            m_last = None
            e_last = None
        
        previous_streak = current_streak
        broke_streak = False
        changed = False
        
        if user == "M":
            m_last = today
        elif user == "E":
            e_last = today
        
        both_posted_today = (m_last == today and e_last == today)
        
        if both_posted_today:
            if last_completed == today:
                pass
            elif last_completed == yesterday:
                current_streak += 1
                last_completed = today
                changed = True
            else:
                current_streak = 1
                last_completed = today
                changed = True
        else:
            if last_completed and last_completed < yesterday and current_streak > 0:
                previous_streak = current_streak
                current_streak = 0
                changed = True
                broke_streak = True
        
        if row:
            conn.execute(text("""
                UPDATE streaks SET current_streak=:streak, last_m_post=:m_last, last_e_post=:e_last,
                last_update_date=:last_completed, updated_at=:ts WHERE drop_id=:drop_id
            """), {"streak": current_streak, "m_last": m_last, "e_last": e_last,
                   "last_completed": last_completed, "ts": now_ts, "drop_id": drop_id})
        else:
            conn.execute(text("""
                INSERT INTO streaks (drop_id, current_streak, last_m_post, last_e_post, last_update_date, updated_at)
                VALUES (:drop_id, :streak, :m_last, :e_last, :last_completed, :ts)
            """), {"drop_id": drop_id, "streak": current_streak, "m_last": m_last, "e_last": e_last,
                   "last_completed": last_completed, "ts": now_ts})
        
        return {
            "streak": current_streak,
            "changed": changed,
            "brokeStreak": broke_streak,
            "previousStreak": previous_streak,
            "bothPostedToday": both_posted_today,
            "mPostedToday": m_last == today,
            "ePostedToday": e_last == today
        }

def get_streak(drop_id: str) -> Dict[str, Any]:
    today = get_est_today()
    yesterday = get_est_yesterday()
    
    with engine.begin() as conn:
        row = conn.execute(text("SELECT * FROM streaks WHERE drop_id = :d"), {"d": drop_id}).mappings().first()
        if not row:
            return {"streak": 0, "bothPostedToday": False, "mPostedToday": False, "ePostedToday": False, "brokeStreak": False, "previousStreak": 0}
        
        current_streak = row["current_streak"] or 0
        last_completed = row.get("last_update_date")
        m_last = row.get("last_m_post")
        e_last = row.get("last_e_post")
        
        broke_streak = False
        previous_streak = current_streak
        if last_completed and last_completed < yesterday and current_streak > 0:
            broke_streak = True
        
        return {
            "streak": 0 if broke_streak else current_streak,
            "bothPostedToday": (m_last == today and e_last == today),
            "mPostedToday": m_last == today,
            "ePostedToday": e_last == today,
            "brokeStreak": broke_streak,
            "previousStreak": previous_streak
        }

@app.get("/api/chat/{drop_id}/streak")
def api_get_streak(drop_id: str, req: Request = None):
    require_session(req)
    return get_streak(drop_id)

@app.post("/api/chat/{drop_id}/streak")
def api_post_streak(drop_id: str, req: Request = None):
    require_session(req)
    return get_streak(drop_id)

# --- Blob serving ---
@app.get("/blob/{blob_id}")
def get_blob(blob_id: str, req: Request):
    require_session(req)
    path = BLOB_DIR / blob_id
    if not path.exists(): raise HTTPException(404)
    mime_type, _ = mimetypes.guess_type(str(path))
    if not mime_type:
        ext = path.suffix.lower()
        if ext in ('.m4a',):
            mime_type = 'audio/mp4'
        elif ext in ('.webm',):
            mime_type = 'audio/webm'
        else:
            mime_type = 'application/octet-stream'
    return FileResponse(path, media_type=mime_type)

# --- Camera Stream Proxy ---
def verify_session(token: str) -> bool:
    return _verify_token(token)

@app.get("/api/camera/stream")
async def camera_stream(request: Request):
    session_token = request.cookies.get(SESSION_COOKIE)
    if not session_token or not verify_session(session_token):
        return Response(status_code=401)
    
    async def generate():
        async with httpx.AsyncClient() as client:
            try:
                async with client.stream("GET", CAMERA_STREAM_URL, timeout=30.0) as response:
                    async for chunk in response.aiter_bytes(chunk_size=4096):
                        yield chunk
            except Exception as e:
                print(f"Camera stream error: {e}")
                return
    
    return StreamingResponse(generate(), media_type="multipart/x-mixed-replace; boundary=frame")

# --- TikTok Video Extraction ---
@app.get("/api/tiktok-video")
async def get_tiktok_video(url: str, req: Request):
    require_session(req)
    if not url: raise HTTPException(400, "url parameter required")
    if 'tiktok.com' not in url.lower(): raise HTTPException(400, "Not a TikTok URL")
    if not url.startswith('http'): url = 'https://' + url
    _clean_tiktok_video_cache()
    cache_key = f"meta:{url}"
    if cache_key in _tiktok_video_cache:
        return _tiktok_video_cache[cache_key]['data']
    try:
        result = await asyncio.to_thread(subprocess.run,
            ['yt-dlp', '--dump-json', '--no-download', '--no-playlist', '--no-warnings', '--quiet', url],
            capture_output=True, text=True, timeout=15)
        if result.returncode != 0: raise HTTPException(502, "Failed to extract video info")
        video_info = json.loads(result.stdout)
        response_data = {"title": video_info.get('title', ''), "author": video_info.get('uploader', ''),
                         "thumbnail": video_info.get('thumbnail', ''), "duration": video_info.get('duration', 0)}
        _tiktok_video_cache[cache_key] = {'data': response_data, 'timestamp': datetime.now()}
        return response_data
    except subprocess.TimeoutExpired: raise HTTPException(504, "Request timeout")
    except json.JSONDecodeError: raise HTTPException(502, "Failed to parse video info")
    except HTTPException: raise
    except Exception as e: raise HTTPException(500, "Internal error")

@app.get("/api/tiktok-video/proxy")
async def proxy_tiktok_video(url: str, req: Request):
    require_session(req)
    if not url: raise HTTPException(400, "url parameter required")
    if 'tiktok.com' not in url.lower(): raise HTTPException(400, "Not a TikTok URL")
    if not url.startswith('http'): url = 'https://' + url
    temp_dir = tempfile.gettempdir()
    temp_filename = f"tiktok_{hash(url) % 1000000}.mp4"
    temp_path = os.path.join(temp_dir, temp_filename)
    try:
        if os.path.exists(temp_path):
            file_age = datetime.now().timestamp() - os.path.getmtime(temp_path)
            if file_age < 1800:
                return FileResponse(temp_path, media_type="video/mp4",
                                   headers={'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=1800'})
        result = await asyncio.to_thread(subprocess.run,
            ['yt-dlp', '-f', 'best[ext=mp4]/best', '-o', temp_path, '--no-playlist', '--no-warnings',
             '--quiet', '--force-overwrites', url],
            capture_output=True, text=True, timeout=30)
        if result.returncode != 0 or not os.path.exists(temp_path): raise HTTPException(502, "Failed to download video")
        return FileResponse(temp_path, media_type="video/mp4",
                           headers={'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=1800'})
    except subprocess.TimeoutExpired: raise HTTPException(504, "Download timeout")
    except HTTPException: raise
    except Exception: raise HTTPException(500, "Internal error")

@app.get("/api/resolve-tiktok")
async def resolve_tiktok(url: str, req: Request):
    require_session(req)
    if not url or 'tiktok.com' not in url.lower(): raise HTTPException(400, "Invalid TikTok URL")
    if not url.startswith('http'): url = 'https://' + url
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as client:
            response = await client.get(url)
            final_url = str(response.url)
            match = TIKTOK_VIDEO_ID_PATTERN.search(final_url)
            if match: return {"videoId": match.group(1), "resolvedUrl": final_url}
            raise HTTPException(404, "Could not extract video ID")
    except httpx.TimeoutException: raise HTTPException(504, "Request timeout")
    except HTTPException: raise
    except Exception: raise HTTPException(500, "Internal error")

# --- WebSocket Hub with presence ---
class Hub:
    def __init__(self):
        self.rooms: Dict[str, Dict[WebSocket, str]] = {}

    async def join(self, drop_id: str, ws: WebSocket, user: str = "anon"):
        await ws.accept()
        self.rooms.setdefault(drop_id, {})[ws] = user
        
        existing_users = {}
        for conn, u in self.rooms.get(drop_id, {}).items():
            if conn != ws and u != user:
                existing_users[u] = True
        
        for existing_user in existing_users.keys():
            await ws.send_json({
                "type": "presence",
                "data": {"user": existing_user, "state": "active", "ts": int(time.time() * 1000)},
                "online": len(self.rooms.get(drop_id, {}))
            })
        
        await self.broadcast_to_others(drop_id, ws, {
            "type": "presence",
            "data": {"user": user, "state": "active", "ts": int(time.time() * 1000)},
            "online": len(self.rooms.get(drop_id, {}))
        })

    async def leave(self, drop_id: str, ws: WebSocket):
        user_label = self.rooms.get(drop_id, {}).get(ws, "anon")
        try:
            del self.rooms.get(drop_id, {})[ws]
            if not self.rooms.get(drop_id): 
                self.rooms.pop(drop_id, None)
        except KeyError:
            pass
        await self.broadcast(drop_id, {
            "type": "presence",
            "data": {"user": user_label, "state": "offline", "ts": int(time.time() * 1000)},
            "online": self._online(drop_id)
        })

    def _online(self, drop_id: str) -> int:
        return len(self.rooms.get(drop_id, {}))

    async def broadcast(self, drop_id: str, payload: Dict[str, Any]):
        conns = list(self.rooms.get(drop_id, {}).keys())
        dead = []
        for ws in conns:
            try: await ws.send_json(payload)
            except Exception: dead.append(ws)
        for ws in dead: await self.leave(drop_id, ws)

    async def broadcast_to_others(self, drop_id: str, sender_ws: WebSocket, payload: Dict[str, Any]):
        conns = list(self.rooms.get(drop_id, {}).keys())
        dead = []
        for ws in conns:
            if ws == sender_ws: continue
            try: await ws.send_json(payload)
            except Exception: dead.append(ws)
        for ws in dead: await self.leave(drop_id, ws)

hub = Hub()

# --- Game State Management ---
class GameManager:
    def __init__(self):
        self.games: Dict[str, Dict[str, Any]] = {}

    def create_game(self, drop_id: str, game_type: str, game_data: Dict[str, Any]) -> str:
        import uuid
        game_id = f"game_{uuid.uuid4().hex[:12]}"
        self.games[game_id] = {
            "gameId": game_id, "dropId": drop_id, "gameType": game_type,
            "gameData": game_data, "status": "active",
            "created": int(time.time() * 1000), "players": []
        }
        return game_id

    def get_game(self, game_id: str) -> Optional[Dict[str, Any]]:
        return self.games.get(game_id)

    def update_game(self, game_id: str, updates: Dict[str, Any]):
        if game_id in self.games:
            self.games[game_id].update(updates)

    def end_game(self, game_id: str):
        if game_id in self.games:
            self.games[game_id]["status"] = "ended"

    def get_active_games(self, drop_id: str) -> List[Dict[str, Any]]:
        active = []
        for game_id, game in self.games.items():
            if game.get("dropId") == drop_id and game.get("status") == "active":
                active.append({"gameId": game_id, "gameType": game.get("gameType"),
                               "created": game.get("created"), "gameData": game.get("gameData")})
        return active

game_manager = GameManager()

# --- GeoGuessr Game State Management ---
class GeoGameManager:
    def __init__(self):
        self.games: Dict[str, Dict[str, Any]] = {}

    def create_game(self, game_id: str, drop_id: str, starter: str, locations: list):
        self.games[game_id] = {
            "gameId": game_id, "dropId": drop_id, "starter": starter,
            "status": "active", "currentRound": 1, "totalRounds": 5,
            "locations": locations, "scores": {"E": 0, "M": 0},
            "guesses": {}, "roundResults": {},
            "createdAt": int(time.time() * 1000),
        }

    def get_game(self, game_id: str) -> Optional[Dict[str, Any]]:
        return self.games.get(game_id)

    def record_guess(self, game_id: str, player: str, lat: float, lng: float) -> bool:
        game = self.games.get(game_id)
        if not game:
            return False
        rnd = game["currentRound"]
        game["guesses"].setdefault(rnd, {})
        game["guesses"][rnd][player] = {"lat": lat, "lng": lng}
        return len(game["guesses"][rnd]) == 2

    def calculate_round_result(self, game_id: str) -> Dict:
        game = self.games[game_id]
        rnd = game["currentRound"]
        loc = game["locations"][rnd - 1]
        guesses = game["guesses"][rnd]
        result = {}
        for player in ["E", "M"]:
            if player in guesses:
                g = guesses[player]
                dist = haversine(loc["lat"], loc["lng"], g["lat"], g["lng"])
                score = geo_score(dist)
                result[player] = {"distance": round(dist, 1), "score": score,
                                  "guessLat": g["lat"], "guessLng": g["lng"]}
                game["scores"][player] += score
        game["roundResults"][rnd] = result
        return result

    def advance_round(self, game_id: str) -> int:
        game = self.games.get(game_id)
        if not game:
            return 0
        if game["currentRound"] >= game["totalRounds"]:
            game["status"] = "ended"
            return 0
        game["currentRound"] += 1
        return game["currentRound"]

    def end_game(self, game_id: str):
        if game_id in self.games:
            self.games[game_id]["status"] = "ended"

geo_game_manager = GeoGameManager()

def _build_full_drop(drop: str) -> dict:
    with engine.begin() as conn:
        rows = conn.execute(text("select * from messages where drop_id=:d order by seq"), {"d": drop}).mappings().all()
        max_seq = conn.execute(text("select coalesce(max(seq),0) as v from messages where drop_id=:d"), {"d": drop}).scalar()
    
    out = []
    images = []
    for r in rows:
        o = dict(r)
        msg = {
            "message": o.get("text"),
            "seq": o.get("seq"),
            "createdAt": o.get("created_at"),
            "updatedAt": o.get("updated_at"),
            "user": o.get("user"),
            "clientId": o.get("client_id"),
            "messageType": o.get("message_type"),
            "reactions": json.loads(o.get("reactions") or "{}"),
            "gifUrl": o.get("gif_url"),
            "gifPreview": o.get("gif_preview"),
            "gifWidth": o.get("gif_width"),
            "gifHeight": o.get("gif_height"),
            "imageUrl": o.get("image_url"),
            "imageThumb": o.get("image_thumb"),
            "replyToSeq": o.get("reply_to_seq"),
            "deliveredAt": o.get("delivered_at"),
            "readAt": o.get("read_at"),
            "audioDuration": o.get("audio_duration"),
        }
        if o.get("blob_id"):
            msg["img"] = f"/blob/{o['blob_id']}"
            if o.get("message_type") == "audio":
                msg["audioUrl"] = f"/blob/{o['blob_id']}"
            else:
                images.append({
                    "imageId": o["blob_id"], "mime": o.get("mime"),
                    "originalUrl": msg["img"], "thumbUrl": msg["img"],
                    "uploadedAt": o.get("ts"),
                })
        out.append(msg)
    
    return {"dropId": drop, "version": int(max_seq or 0), "messages": out, "images": images}

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    params = dict(ws.query_params)
    session_token = params.get("sessionToken") or params.get("sess")
    if not session_token or not _verify_token(session_token):
        await ws.close(code=1008)
        return

    drop = params.get("drop") or params.get("dropId") or "default"
    edge = params.get("edge")
    if EDGE_AUTH_TOKEN and edge != EDGE_AUTH_TOKEN:
        await ws.close(code=4401)
        return

    user = params.get("user") or params.get("role") or "anon"
    await hub.join(drop, ws, user)

    # ── Replay pending call for late joiners ──────────────────────────────
    # If a call was initiated while this user was not connected, send them
    # the 'incoming' signal now so they can still answer it.
    pending = _get_pending_call(drop)
    if pending and pending.get("from") != user:
        # Only relay to the callee (not back to the caller)
        try:
            await ws.send_json({
                "type": "video_signal",
                "payload": {
                    "op": "incoming",
                    "from": pending.get("from"),
                    "peerId": pending.get("peerId"),
                }
            })
            logger.info(f"[PendingCall] Replayed incoming call to late joiner {user} in drop={drop}")
        except Exception as e:
            logger.warning(f"[PendingCall] Failed to replay call to {user}: {e}")

    try:
        while True:
            msg = await ws.receive_json()
            t = msg.get("type") or msg.get("action")
            payload = msg.get("payload") or msg

            if t == "typing":
                typing_payload = dict(payload or {})
                typing_payload["user"] = user
                await hub.broadcast(drop, {"type": "typing", "payload": typing_payload})

            elif t == "ping":
                await ws.send_json({"type": "pong", "ts": int(time.time()*1000)})

            elif t == "notify":
                notify(f"{msg}")

            elif t == "presence":
                try:
                    presence_payload = {
                        "user": (payload or {}).get("user") or user,
                        "state": (payload or {}).get("state", "active"),
                        "ts": (payload or {}).get("ts", int(time.time() * 1000)),
                    }
                except Exception:
                    presence_payload = {"user": user, "state": "active", "ts": int(time.time()*1000)}
                await hub.broadcast_to_others(drop, ws, {"type": "presence", "data": presence_payload, "online": hub._online(drop)})

            elif t == "presence_request":
                await hub.broadcast(drop, {"type": "presence_request", "data": {"ts": int(time.time() * 1000)}})

            elif t == "read":
                up_to_seq = (payload or {}).get("upToSeq")
                reader = (payload or {}).get("reader") or user
                if up_to_seq is not None:
                    now_ms = int(time.time() * 1000)
                    with engine.begin() as conn:
                        conn.execute(text("""
                            UPDATE messages SET read_at = :now 
                            WHERE drop_id = :d AND seq <= :seq AND user != :reader AND read_at IS NULL
                        """), {"now": now_ms, "d": drop, "seq": up_to_seq, "reader": reader})
                    await hub.broadcast(drop, {
                        "type": "read_receipt",
                        "data": {"upToSeq": up_to_seq, "reader": reader, "readAt": now_ms}
                    })

            elif t == "video_signal":
                op        = (payload or {}).get("op", "")
                from_user = (payload or {}).get("from") or user

                # ── Manage pending call state ──────────────────────────────
                if op == "incoming":
                    _store_pending_call(drop, {
                        "op": "incoming",
                        "from": from_user,
                        "peerId": (payload or {}).get("peerId", ""),
                    })
                    # SMS alert
                    if _should_notify("video_call", drop, 120):
                        caller_name = from_user or "Someone"
                        notify(f"{caller_name} is calling... Open MSGDrop to answer! 📹")

                elif op in ("ended", "declined", "answered"):
                    _clear_pending_call(drop)

                # Pass-through to the other participant's WS connection
                await hub.broadcast_to_others(drop, ws, {
                    "type": "video_signal",
                    "payload": payload
                })
                logger.info(f"[VideoSignal] op={op} from={from_user}")

            elif t == "chat":
                text_val = (payload or {}).get("text") or ""
                msg_user = (payload or {}).get("user") or user
                client_id = (payload or {}).get("clientId")
                reply_to_seq = (payload or {}).get("replyToSeq")
                if not text_val:
                    await ws.send_json({"type": "error", "error": "text required"})
                    continue
                ts = int(time.time() * 1000)
                msg_id = secrets.token_hex(8)
                with engine.begin() as conn:
                    row = conn.execute(text("select coalesce(max(seq),0)+1 as next from messages where drop_id=:d"), {"d": drop}).mappings().first()
                    next_seq = int(row["next"]) if row else 1
                    conn.execute(text("""
                        insert into messages(id,drop_id,seq,ts,created_at,updated_at,user,client_id,message_type,text,reactions,reply_to_seq,delivered_at,audio_duration)
                        values(:id,:d,:seq,:ts,:ca,:ua,:u,:cid,:mt,:tx,:rx,:rts,:del,:adur)
                    """), {"id": msg_id, "d": drop, "seq": next_seq, "ts": ts,
                           "ca": ts, "ua": ts, "u": msg_user, "cid": client_id,
                           "mt": "text", "tx": text_val, "rx": "{}", "rts": reply_to_seq, "del": ts, "adur": 0})
                cleanup_old_messages(drop, keep_count=30)
                user_normalized = (msg_user or "").strip() or "E"
                streak_result = update_streak_on_message(drop, user_normalized)
                if streak_result["changed"]:
                    streak_data = get_streak(drop)
                    await hub.broadcast(drop, {"type": "streak", "data": streak_data})
                full_drop = _build_full_drop(drop)
                await hub.broadcast(drop, {"type": "update", "data": full_drop})
                if (msg_user or "").upper() == "E" and _should_notify("msg", drop, 60):
                    notify("E posted a new message")

            elif t == "gif":
                gif_url_v = (payload or {}).get("gifUrl")
                gif_preview = (payload or {}).get("gifPreview")
                gif_width = (payload or {}).get("gifWidth", 0)
                gif_height = (payload or {}).get("gifHeight", 0)
                title = (payload or {}).get("title") or "[GIF]"
                msg_user = (payload or {}).get("user") or user
                client_id = (payload or {}).get("clientId")
                if not gif_url_v:
                    await ws.send_json({"type": "error", "error": "gifUrl required"})
                    continue
                ts = int(time.time() * 1000)
                msg_id = secrets.token_hex(8)
                with engine.begin() as conn:
                    row = conn.execute(text("select coalesce(max(seq),0)+1 as next from messages where drop_id=:d"), {"d": drop}).mappings().first()
                    next_seq = int(row["next"]) if row else 1
                    conn.execute(text("""
                        insert into messages(id,drop_id,seq,ts,created_at,updated_at,user,client_id,message_type,text,reactions,gif_url,gif_preview,gif_width,gif_height,audio_duration)
                        values(:id,:d,:seq,:ts,:ca,:ua,:u,:cid,:mt,:tx,:rx,:gurl,:gprev,:gw,:gh,:adur)
                    """), {"id": msg_id, "d": drop, "seq": next_seq, "ts": ts,
                           "ca": ts, "ua": ts, "u": msg_user, "cid": client_id,
                           "mt": "gif", "tx": f"[GIF: {title}]", "rx": "{}",
                           "gurl": gif_url_v, "gprev": gif_preview, "gw": gif_width, "gh": gif_height, "adur": 0})
                cleanup_old_messages(drop, keep_count=30)
                user_normalized = (msg_user or "").strip() or "E"
                streak_result = update_streak_on_message(drop, user_normalized)
                if streak_result["changed"]:
                    streak_data = get_streak(drop)
                    await hub.broadcast(drop, {"type": "streak", "data": streak_data})
                full_drop = _build_full_drop(drop)
                await hub.broadcast(drop, {"type": "update", "data": full_drop})
                if (msg_user or "").upper() == "E" and _should_notify("gif", drop, 60):
                    notify("E sent a GIF")

            elif t == "game":
                op = (payload or {}).get("op")
                if op == "start":
                    game_type = payload.get("gameType", "t3")
                    game_data = payload.get("gameData", {})
                    game_id = game_manager.create_game(drop, game_type, game_data)
                    await hub.broadcast(drop, {"type": "game", "payload": {"op": "started", "gameId": game_id, "gameType": game_type, "gameData": game_data}})
                    if (user or "").upper() == "E" and _should_notify("game", drop, 60):
                        notify("E started a game")
                elif op == "join":
                    game_id = payload.get("gameId")
                    game = game_manager.get_game(game_id)
                    if game:
                        if user not in game.get("players", []):
                            game["players"].append(user)
                            game_manager.update_game(game_id, {"players": game["players"]})
                        await hub.broadcast(drop, {"type": "game", "payload": {"op": "joined", "gameId": game_id, "gameType": game.get("gameType"), "gameData": game.get("gameData"), "player": user}})
                    else:
                        await ws.send_json({"type": "error", "message": f"Game {game_id} not found"})
                elif op == "move":
                    game_id = payload.get("gameId")
                    move_data = payload.get("moveData", {})
                    game = game_manager.get_game(game_id)
                    if game:
                        game_data = game.get("gameData", {})
                        if "board" not in game_data:
                            game_data["board"] = [[None,None,None],[None,None,None],[None,None,None]]
                        r_v = move_data.get("r")
                        c_v = move_data.get("c")
                        mover = move_data.get("by")
                        marker = move_data.get("marker")
                        if not marker and mover:
                            starter = game_data.get("starter")
                            marker = "X" if mover == starter else "O"
                        next_turn = move_data.get("nextTurn")
                        if not next_turn and mover:
                            next_turn = "M" if mover == "E" else "E"
                        if r_v is not None and c_v is not None and marker:
                            game_data["board"][r_v][c_v] = marker
                            if next_turn: game_data["currentTurn"] = next_turn
                            game_manager.update_game(game_id, {"gameData": game_data})
                        await hub.broadcast(drop, {"type": "game", "payload": {"op": "move", "gameId": game_id, "moveData": move_data, "gameData": game_data}})
                elif op == "end_game":
                    game_id = payload.get("gameId")
                    result = payload.get("result")
                    game_manager.end_game(game_id)
                    await hub.broadcast(drop, {"type": "game", "payload": {"op": "game_ended", "gameId": game_id, "result": result}})
                elif op == "request_game_list":
                    active_games = game_manager.get_active_games(drop)
                    await ws.send_json({"type": "game_list", "data": {"games": active_games}})
                elif op in ["player_opened", "player_closed"]:
                    await hub.broadcast(drop, {"type": "game", "payload": payload})

                # --- GeoGuessr ops ---
                elif op == "geo_start":
                    locs = random.sample(GEO_LOCATIONS, min(5, len(GEO_LOCATIONS)))
                    gid = f"geo_{secrets.token_hex(8)}"
                    geo_game_manager.create_game(gid, drop, user, locs)
                    with engine.begin() as conn:
                        conn.execute(text("""
                            insert into geo_games(id,drop_id,started_by,started_at,status,locations)
                            values(:id,:d,:s,:t,'active',:l)
                        """), {"id": gid, "d": drop, "s": user, "t": int(time.time()*1000),
                               "l": json.dumps(locs, separators=(",",":"))})
                        for i, loc in enumerate(locs, 1):
                            conn.execute(text("""
                                insert into geo_rounds(game_id,round_num,lat,lng,country,location_name)
                                values(:gid,:rnd,:lat,:lng,:c,:n)
                            """), {"gid": gid, "rnd": i, "lat": loc["lat"], "lng": loc["lng"],
                                   "c": loc["country"], "n": loc["name"]})
                    loc0 = locs[0]
                    await hub.broadcast(drop, {"type": "game", "payload": {
                        "op": "geo_started", "gameId": gid, "gameType": "geo",
                        "round": 1, "totalRounds": 5,
                        "location": {"lat": loc0["lat"], "lng": loc0["lng"]}
                    }})
                    if (user or "").upper() == "E" and _should_notify("game", drop, 60):
                        notify("E started a GeoGuessr game")

                elif op == "geo_guess":
                    gid = payload.get("gameId")
                    g_lat = payload.get("lat")
                    g_lng = payload.get("lng")
                    game = geo_game_manager.get_game(gid)
                    if not game or g_lat is None or g_lng is None:
                        continue
                    rnd = game["currentRound"]
                    existing = game["guesses"].get(rnd, {})
                    if user in existing:
                        continue
                    both_done = geo_game_manager.record_guess(gid, user, float(g_lat), float(g_lng))
                    await hub.broadcast(drop, {"type": "game", "payload": {
                        "op": "geo_guess_received", "gameId": gid, "player": user, "round": rnd
                    }})
                    if both_done:
                        result = geo_game_manager.calculate_round_result(gid)
                        loc = game["locations"][rnd - 1]
                        now_ms = int(time.time() * 1000)
                        with engine.begin() as conn:
                            for p in ["E", "M"]:
                                if p in result:
                                    r = result[p]
                                    col_prefix = p.lower()
                                    conn.execute(text(f"""
                                        update geo_rounds set
                                            {col_prefix}_guess_lat=:glat, {col_prefix}_guess_lng=:glng,
                                            {col_prefix}_distance_km=:dist, {col_prefix}_score=:score,
                                            {col_prefix}_guessed_at=:ts, revealed_at=:ts
                                        where game_id=:gid and round_num=:rnd
                                    """), {"glat": r["guessLat"], "glng": r["guessLng"],
                                           "dist": r["distance"], "score": r["score"],
                                           "ts": now_ms, "gid": gid, "rnd": rnd})
                        await hub.broadcast(drop, {"type": "game", "payload": {
                            "op": "geo_round_result", "gameId": gid, "round": rnd,
                            "location": {"lat": loc["lat"], "lng": loc["lng"],
                                         "country": loc["country"], "name": loc["name"]},
                            "results": result, "totalScores": game["scores"]
                        }})
                        if rnd >= game["totalRounds"]:
                            winner = "E" if game["scores"]["E"] > game["scores"]["M"] else (
                                "M" if game["scores"]["M"] > game["scores"]["E"] else "tie")
                            with engine.begin() as conn:
                                conn.execute(text("""
                                    update geo_games set status='ended',ended_at=:ts,
                                        e_total_score=:es,m_total_score=:ms,winner=:w
                                    where id=:gid
                                """), {"ts": int(time.time()*1000), "es": game["scores"]["E"],
                                       "ms": game["scores"]["M"], "w": winner, "gid": gid})
                            all_rounds = []
                            for r_num in range(1, 6):
                                loc_r = game["locations"][r_num - 1]
                                all_rounds.append({"round": r_num, "location": loc_r,
                                                   "results": game["roundResults"].get(r_num, {})})
                            await hub.broadcast(drop, {"type": "game", "payload": {
                                "op": "geo_game_end", "gameId": gid,
                                "totalScores": game["scores"], "winner": winner,
                                "roundResults": all_rounds
                            }})
                            geo_game_manager.end_game(gid)

                elif op == "geo_next":
                    gid = payload.get("gameId")
                    game = geo_game_manager.get_game(gid)
                    if not game:
                        continue
                    new_round = geo_game_manager.advance_round(gid)
                    if new_round > 0:
                        loc = game["locations"][new_round - 1]
                        await hub.broadcast(drop, {"type": "game", "payload": {
                            "op": "geo_next_round", "gameId": gid,
                            "round": new_round, "totalRounds": 5,
                            "location": {"lat": loc["lat"], "lng": loc["lng"]}
                        }})

                elif op == "geo_forfeit":
                    gid = payload.get("gameId")
                    geo_game_manager.end_game(gid)
                    with engine.begin() as conn:
                        conn.execute(text("update geo_games set status='forfeit',ended_at=:ts where id=:gid"),
                                     {"ts": int(time.time()*1000), "gid": gid})
                    await hub.broadcast(drop, {"type": "game", "payload": {
                        "op": "geo_forfeit", "gameId": gid, "player": user
                    }})

                elif op in ["geo_player_opened", "geo_player_closed"]:
                    await hub.broadcast(drop, {"type": "game", "payload": payload})

                else:
                    await hub.broadcast(drop, {"type": "game", "payload": payload})

    except WebSocketDisconnect:
        await hub.leave(drop, ws)

# --- GeoGuessr REST endpoints ---
@app.get("/api/geo/config")
def geo_config(req: Request):
    require_session(req)
    return {"mapsApiKey": GOOGLE_MAPS_API_KEY}

@app.get("/api/geo/scores/{drop_id}")
def get_geo_scores(drop_id: str, limit: int = 20, req: Request = None):
    require_session(req)
    with engine.begin() as conn:
        rows = conn.execute(text("""
            select id,started_by,started_at,ended_at,e_total_score,m_total_score,winner
            from geo_games where drop_id=:d and status in ('ended','forfeit')
            order by started_at desc limit :n
        """), {"d": drop_id, "n": limit}).mappings().all()
    games = [dict(r) for r in rows]
    e_wins = sum(1 for g in games if g["winner"] == "E")
    m_wins = sum(1 for g in games if g["winner"] == "M")
    ties = sum(1 for g in games if g["winner"] == "tie")
    return {"games": games, "stats": {"eWins": e_wins, "mWins": m_wins, "ties": ties, "total": len(games)}}

# --- Static UI ---
app.mount("/msgdrop", StaticFiles(directory="html", html=True), name="msgdrop")
app.mount("/images", StaticFiles(directory="html/images"), name="images")
app.mount("/css", StaticFiles(directory="html/css"), name="css")
app.mount("/js", StaticFiles(directory="html/js"), name="js")

@app.get("/")
def root_redirect():
    return RedirectResponse(url="/msgdrop", status_code=307)

@app.get("/unlock")
def unlock_page():
    index_path = Path("html/unlock.html")
    if index_path.exists():
        return FileResponse(index_path)
    return RedirectResponse(url="/msgdrop", status_code=302)

@app.get("/msgdrop/unlock")
def unlock_redirect():
    return RedirectResponse(url="/unlock", status_code=307)


if __name__ == "__main__":
    import uvicorn
    ssl_cert = os.environ.get("SSL_CERT_PATH")
    ssl_key = os.environ.get("SSL_KEY_PATH")
    port = int(os.environ.get("PORT", "443"))
    try:
        cert_exists = ssl_cert and Path(ssl_cert).exists()
        key_exists = ssl_key and Path(ssl_key).exists()
    except Exception:
        cert_exists = key_exists = False

    if cert_exists and key_exists:
        uvicorn.run(app, host="0.0.0.0", port=port, ssl_certfile=ssl_cert, ssl_keyfile=ssl_key, proxy_headers=True, log_level="info")
    else:
        uvicorn.run(app, host="0.0.0.0", port=port, proxy_headers=True, log_level="info")
