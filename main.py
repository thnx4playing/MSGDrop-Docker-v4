import os, json, hmac, hashlib, time, secrets, mimetypes, logging, re
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

init_db()

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
                else:
                    await hub.broadcast(drop, {"type": "game", "payload": payload})

    except WebSocketDisconnect:
        await hub.leave(drop, ws)

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
