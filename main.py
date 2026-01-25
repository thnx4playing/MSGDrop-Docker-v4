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
# Default to 5 minutes
SESSION_TTL     = int(os.environ.get("SESSION_TTL_SECONDS", "300"))
SESSION_COOKIE  = "msgdrop_sess"
UI_COOKIE       = "session-ok"
DATA_DIR        = Path(os.environ.get("DATA_DIR", "/data"))
BLOB_DIR        = DATA_DIR / "blob"
DB_PATH         = DATA_DIR / "messages.db"

# Internal-only by default: do not reach outside unless explicitly allowed
ALLOW_EXTERNAL_FETCH = os.environ.get("ALLOW_EXTERNAL_FETCH", "false").lower() == "true"

MSGDROP_SECRET_JSON = os.environ.get("MSGDROP_SECRET_JSON", "")
try:
    _cfg = json.loads(MSGDROP_SECRET_JSON) if MSGDROP_SECRET_JSON else {}
except Exception:
    _cfg = {}
# Twilio config
TWILIO_ACCOUNT_SID = _cfg.get("account_sid", "")
TWILIO_AUTH_TOKEN = _cfg.get("auth_token", "")
TWILIO_FROM_NUMBER = _cfg.get("from_number") or _cfg.get("from", "")
NOTIFY_NUMBERS = _cfg.get("notify_numbers") or _cfg.get("notify") or _cfg.get("to_numbers") or []
if isinstance(NOTIFY_NUMBERS, str):
    NOTIFY_NUMBERS = [NOTIFY_NUMBERS]
EDGE_AUTH_TOKEN = _cfg.get("edgeAuthToken", "")  # optional in mono mode

UNLOCK_CODE_HASH = os.environ.get("UNLOCK_CODE_HASH", "")
UNLOCK_CODE      = os.environ.get("UNLOCK_CODE", "")

# Camera stream URL for proxying
CAMERA_STREAM_URL = "https://cam.efive.org/api/reolink_e1_zoom"

# TikTok URL resolution pattern
TIKTOK_VIDEO_ID_PATTERN = re.compile(r'/video/(\d+)')

# TikTok video URL cache
_tiktok_video_cache = {}
_TIKTOK_CACHE_TTL = timedelta(minutes=30)

def _clean_tiktok_video_cache():
    """Remove expired cache entries"""
    now = datetime.now()
    expired = [k for k, v in _tiktok_video_cache.items() if now - v['timestamp'] > _TIKTOK_CACHE_TTL]
    for k in expired:
        del _tiktok_video_cache[k]

# Secret to sign sessions; derive from env or generate stable file-based secret
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

# Cache-control middleware for static assets
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
    # Create parent dir
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
            read_at integer
        );
        """)
        
        # Migration: Add new columns if they don't exist (for existing databases)
        try:
            conn.exec_driver_sql("ALTER TABLE messages ADD COLUMN reply_to_seq integer")
        except Exception:
            pass
        try:
            conn.exec_driver_sql("ALTER TABLE messages ADD COLUMN delivered_at integer")
        except Exception:
            pass
        try:
            conn.exec_driver_sql("ALTER TABLE messages ADD COLUMN read_at integer")
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
    """Send SMS notification via Twilio"""
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

    # JS-readable cookie with the same token for WebSocket auth
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
        logger.debug(f"Token check: exp={exp_time}, now={current_time}, diff={exp_time - current_time}")
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
    # Set HttpOnly session cookie
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_TTL,  # Cookie expires when token expires
        httponly=True,
        secure=True,
        samesite="lax",
        domain=(COOKIE_DOMAIN or None),
        path="/",
    )
    # Set JS-readable cookie for WS
    response.set_cookie(
        key=UI_COOKIE,
        value=token,
        max_age=SESSION_TTL,  # Cookie expires when token expires
        httponly=False,
        secure=True,
        samesite="lax",
        domain=(COOKIE_DOMAIN or None),
        path="/",
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

    # Success - clear attempts and issue dual cookies
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
        # Transform DB fields (snake_case) to frontend format (camelCase)
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
            # Reply and receipt fields
            "replyToSeq": o.get("reply_to_seq"),
            "deliveredAt": o.get("delivered_at"),
            "readAt": o.get("read_at"),
        }
        if o.get("blob_id"):
            msg["img"] = f"/blob/{o['blob_id']}"
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
    """Lightweight endpoint for session validation"""
    require_session(req)
    return Response(status_code=200)

def cleanup_old_messages(drop_id: str, keep_count: int = 30):
    """Keep only the most recent N messages for a drop."""
    with engine.begin() as conn:
        # Get the seq threshold
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
        
        # Get blob_ids to delete files
        old_blobs = conn.execute(text("""
            select blob_id from messages 
            where drop_id = :d and seq < :threshold and blob_id is not null
        """), {"d": drop_id, "threshold": threshold_seq}).fetchall()
        
        # Delete old messages
        result = conn.execute(text("""
            delete from messages 
            where drop_id = :d and seq < :threshold
        """), {"d": drop_id, "threshold": threshold_seq})
        
        # Delete blob files
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

    # If JSON body provided (GIF/image URL style)
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
            # Extract GIF metadata
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
        message_type = "image"
        # Set image URLs for display in chat
        image_url = f"/blob/{blob_id}"
        image_thumb = f"/blob/{blob_id}"
        if not text_:
            text_ = "[Image]"

    with engine.begin() as conn:
        # allocate next seq per drop
        row = conn.execute(text("select coalesce(max(seq),0)+1 as next from messages where drop_id=:d"), {"d": drop_id}).mappings().first()
        next_seq = int(row["next"]) if row else 1
        now_ms = ts
        conn.execute(text("""
          insert into messages(id,drop_id,seq,ts,created_at,updated_at,user,client_id,message_type,text,blob_id,mime,reactions,gif_url,gif_preview,gif_width,gif_height,image_url,image_thumb,reply_to_seq,delivered_at)
          values(:id,:d,:seq,:ts,:ca,:ua,:u,:cid,:mt,:tx,:b,:m,:rx,:gurl,:gprev,:gw,:gh,:iurl,:ithumb,:rts,:del)
        """), {"id": msg_id, "d": drop_id, "seq": next_seq, "ts": ts, "ca": now_ms, "ua": now_ms,
                "u": user, "cid": None, "mt": message_type, "tx": text_, "b": blob_id, "m": mime, "rx": "{}",
                "gurl": gif_url, "gprev": gif_preview, "gw": gif_width, "gh": gif_height, "iurl": image_url, "ithumb": image_thumb,
                "rts": reply_to_seq, "del": now_ms})

    # Cleanup old messages (keep only 30 most recent)
    cleanup_old_messages(drop_id, keep_count=30)

    # Update streak and broadcast if changed
    user_normalized = (user or "").strip() or "E"
    streak_result = update_streak_on_message(drop_id, user_normalized)
    
    if streak_result["changed"]:
        streak_data = get_streak(drop_id)
        await hub.broadcast(drop_id, {
            "type": "streak",
            "data": streak_data
        })
    
    await hub.broadcast(drop_id, {
        "type": "update",
        "message": {
            "id": msg_id, "drop_id": drop_id, "seq": next_seq, "ts": ts, "user": user, "text": text_,
            "blob_id": blob_id, "mime": mime, "img": (f"/blob/{blob_id}" if blob_id else None)
        }
    })
    # Notify only when E posts a new message, debounce 60s to avoid spam
    if (user or "").upper() == "E" and _should_notify("msg", drop_id, 60):
        notify("E posted a new message")
    # Return fresh list to match frontend expectations
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
    # Try to remove blob if tied to this message
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
    """Mark messages as read up to a certain seq number"""
    require_session(req)
    up_to_seq = body.get("upToSeq")
    reader = body.get("reader")  # User who read the messages (E or M)
    
    if up_to_seq is None or not reader:
        raise HTTPException(400, "upToSeq and reader required")
    
    now_ms = int(time.time() * 1000)
    
    # Only mark messages from the OTHER user as read
    with engine.begin() as conn:
        # Mark as read: messages not from the reader, up to the specified seq
        result = conn.execute(text("""
            UPDATE messages 
            SET read_at = :now 
            WHERE drop_id = :d 
              AND seq <= :seq 
              AND user != :reader 
              AND read_at IS NULL
        """), {"now": now_ms, "d": drop_id, "seq": up_to_seq, "reader": reader})
        
        updated_count = result.rowcount
    
    # Broadcast read receipt to all connections
    if updated_count > 0:
        await hub.broadcast(drop_id, {
            "type": "read_receipt",
            "data": {
                "upToSeq": up_to_seq,
                "reader": reader,
                "readAt": now_ms
            }
        })
    
    return {"success": True, "updated": updated_count}

@app.delete("/api/chat/{drop_id}/images/{image_id}")
async def delete_image(drop_id: str, image_id: str, req: Request = None):
    require_session(req)
    logger.info(f"[delete_image] drop_id={drop_id}, image_id={image_id}")
    
    # Delete any messages that reference this blob in this drop
    with engine.begin() as conn:
        result = conn.execute(text("delete from messages where drop_id=:d and blob_id=:b"), 
                             {"d": drop_id, "b": image_id})
        deleted_count = result.rowcount
        logger.info(f"[delete_image] Deleted {deleted_count} message(s) referencing blob {image_id}")
    
    # Delete the actual file
    file_path = BLOB_DIR / image_id
    try:
        if file_path.exists():
            file_path.unlink()
            logger.info(f"[delete_image] Successfully deleted file {image_id}")
        else:
            logger.warning(f"[delete_image] File {image_id} not found (may have been already deleted)")
    except Exception as e:
        logger.error(f"[delete_image] Failed to delete file {image_id}: {e}")
        # Continue anyway - DB records are already deleted
    
    await hub.broadcast(drop_id, {"type": "update"})
    return list_messages(drop_id, req=req)

# --- Streaks (Simplified Design) ---
from zoneinfo import ZoneInfo
import datetime as _dt

NY_TZ = ZoneInfo("America/New_York")

def get_est_today() -> str:
    """Get today's date in EST as YYYY-MM-DD string"""
    return _dt.datetime.now(NY_TZ).strftime("%Y-%m-%d")

def get_est_yesterday() -> str:
    """Get yesterday's date in EST as YYYY-MM-DD string"""
    return (_dt.datetime.now(NY_TZ) - _dt.timedelta(days=1)).strftime("%Y-%m-%d")

def update_streak_on_message(drop_id: str, user: str) -> Dict[str, Any]:
    """
    Simplified streak logic:
    - Both users must post each day to maintain streak
    - Streak increments when both post on consecutive days
    - Returns: {"streak": int, "changed": bool, "brokeStreak": bool, "previousStreak": int}
    """
    today = get_est_today()
    yesterday = get_est_yesterday()
    now_ts = int(time.time() * 1000)
    
    logger.info(f"[STREAK] Message from {user} on {today}")
    
    with engine.begin() as conn:
        # Get or create streak record
        row = conn.execute(text(
            "SELECT * FROM streaks WHERE drop_id = :d"
        ), {"d": drop_id}).mappings().first()
        
        if row:
            current_streak = row["current_streak"] or 0
            last_completed = row.get("last_update_date")  # Reusing this field as "last_completed_date"
            m_last = row.get("last_m_post")
            e_last = row.get("last_e_post")
        else:
            current_streak = 0
            last_completed = None
            m_last = None
            e_last = None
        
        # Track previous streak for "broke" detection
        previous_streak = current_streak
        broke_streak = False
        changed = False
        
        # Update the posting user's date
        if user == "M":
            m_last = today
        elif user == "E":
            e_last = today
        
        # Check if both have posted today
        both_posted_today = (m_last == today and e_last == today)
        
        logger.info(f"[STREAK] State: streak={current_streak}, last_completed={last_completed}, m_last={m_last}, e_last={e_last}, both_today={both_posted_today}")
        
        if both_posted_today:
            if last_completed == today:
                # Already counted today - no change
                logger.info(f"[STREAK] Already completed today, no change")
            elif last_completed == yesterday:
                # Consecutive days - INCREMENT!
                current_streak += 1
                last_completed = today
                changed = True
                logger.info(f"[STREAK] ✅ Consecutive day! Streak now {current_streak}")
            else:
                # Gap in posting (or first time) - start fresh at 1
                current_streak = 1
                last_completed = today
                changed = True
                logger.info(f"[STREAK] ✅ Fresh start! Streak now 1")
        else:
            # Only one user has posted today
            # Check if we need to break the streak (missed yesterday entirely)
            if last_completed and last_completed < yesterday and current_streak > 0:
                logger.info(f"[STREAK] ❌ Missed day detected, breaking streak from {current_streak} to 0")
                previous_streak = current_streak
                current_streak = 0
                changed = True
                broke_streak = True
        
        # Upsert the record
        if row:
            conn.execute(text("""
                UPDATE streaks 
                SET current_streak = :streak,
                    last_m_post = :m_last,
                    last_e_post = :e_last,
                    last_update_date = :last_completed,
                    updated_at = :ts
                WHERE drop_id = :drop_id
            """), {
                "streak": current_streak,
                "m_last": m_last,
                "e_last": e_last,
                "last_completed": last_completed,
                "ts": now_ts,
                "drop_id": drop_id
            })
        else:
            conn.execute(text("""
                INSERT INTO streaks (drop_id, current_streak, last_m_post, last_e_post, last_update_date, updated_at)
                VALUES (:drop_id, :streak, :m_last, :e_last, :last_completed, :ts)
            """), {
                "drop_id": drop_id,
                "streak": current_streak,
                "m_last": m_last,
                "e_last": e_last,
                "last_completed": last_completed,
                "ts": now_ts
            })
        
        logger.info(f"[STREAK] Final: streak={current_streak}, changed={changed}, broke={broke_streak}")
        
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
    """Get current streak data"""
    today = get_est_today()
    yesterday = get_est_yesterday()
    
    with engine.begin() as conn:
        row = conn.execute(text(
            "SELECT * FROM streaks WHERE drop_id = :d"
        ), {"d": drop_id}).mappings().first()
        
        if not row:
            return {
                "streak": 0,
                "bothPostedToday": False,
                "mPostedToday": False,
                "ePostedToday": False,
                "brokeStreak": False,
                "previousStreak": 0
            }
        
        current_streak = row["current_streak"] or 0
        last_completed = row.get("last_update_date")
        m_last = row.get("last_m_post")
        e_last = row.get("last_e_post")
        
        # Check if streak should be broken (missed day)
        broke_streak = False
        previous_streak = current_streak
        
        if last_completed and last_completed < yesterday and current_streak > 0:
            # Streak is stale - should be broken
            # We'll return broke info but NOT update DB here (let message trigger that)
            broke_streak = True
            previous_streak = current_streak
            logger.info(f"[STREAK] GET detected stale streak: {current_streak} days, last_completed={last_completed}, returning broke=True")
            # Note: We return the broken state but don't persist until next message
        
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
    # This endpoint is now deprecated but kept for compatibility
    # Streaks update automatically on message post
    require_session(req)
    return get_streak(drop_id)

# --- Blob serving ---
@app.get("/blob/{blob_id}")
def get_blob(blob_id: str, req: Request):
    require_session(req)
    path = BLOB_DIR / blob_id
    if not path.exists(): raise HTTPException(404)
    return FileResponse(path)

# --- Camera Stream Proxy ---
def verify_session(token: str) -> bool:
    """Verify session token - wrapper for _verify_token"""
    return _verify_token(token)

@app.get("/api/camera/stream")
async def camera_stream(request: Request):
    # Require authentication
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
    
    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

# --- TikTok Video Extraction ---
@app.get("/api/tiktok-video")
async def get_tiktok_video(url: str, req: Request):
    """
    Extract video metadata from TikTok using yt-dlp.
    Returns thumbnail, title, author info.
    """
    require_session(req)
    
    if not url:
        raise HTTPException(400, "url parameter required")
    
    if 'tiktok.com' not in url.lower():
        raise HTTPException(400, "Not a TikTok URL")
    
    if not url.startswith('http'):
        url = 'https://' + url
    
    # Check cache first
    _clean_tiktok_video_cache()
    cache_key = f"meta:{url}"
    if cache_key in _tiktok_video_cache:
        logger.info(f"[TikTok] Cache hit for {url}")
        return _tiktok_video_cache[cache_key]['data']
    
    try:
        # Run yt-dlp to extract video info
        result = await asyncio.to_thread(
            subprocess.run,
            [
                'yt-dlp',
                '--dump-json',
                '--no-download',
                '--no-playlist',
                '--no-warnings',
                '--quiet',
                url
            ],
            capture_output=True,
            text=True,
            timeout=15
        )
        
        if result.returncode != 0:
            logger.error(f"[TikTok] yt-dlp error: {result.stderr}")
            raise HTTPException(502, "Failed to extract video info")
        
        # Parse JSON output
        video_info = json.loads(result.stdout)
        
        response_data = {
            "title": video_info.get('title', ''),
            "author": video_info.get('uploader', video_info.get('creator', '')),
            "thumbnail": video_info.get('thumbnail', ''),
            "duration": video_info.get('duration', 0),
        }
        
        # Cache the result
        _tiktok_video_cache[cache_key] = {
            'data': response_data,
            'timestamp': datetime.now()
        }
        
        logger.info(f"[TikTok] Extracted metadata: {video_info.get('title', 'Unknown')}")
        return response_data
        
    except subprocess.TimeoutExpired:
        logger.error(f"[TikTok] Timeout extracting: {url}")
        raise HTTPException(504, "Request timeout")
    except json.JSONDecodeError as e:
        logger.error(f"[TikTok] JSON parse error: {e}")
        raise HTTPException(502, "Failed to parse video info")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TikTok] Unexpected error: {e}")
        raise HTTPException(500, "Internal error")

@app.get("/api/tiktok-video/proxy")
async def proxy_tiktok_video(url: str, req: Request):
    """
    Download and serve a TikTok video using yt-dlp.
    Downloads to temp file then streams to client.
    """
    require_session(req)
    
    if not url:
        raise HTTPException(400, "url parameter required")
    
    if 'tiktok.com' not in url.lower():
        raise HTTPException(400, "Not a TikTok URL")
    
    if not url.startswith('http'):
        url = 'https://' + url
    
    # Create a temp file for the video
    temp_dir = tempfile.gettempdir()
    temp_filename = f"tiktok_{hash(url) % 1000000}.mp4"
    temp_path = os.path.join(temp_dir, temp_filename)
    
    try:
        # Check if we already have this video cached
        if os.path.exists(temp_path):
            # Check if file is recent (less than 30 min old)
            file_age = datetime.now().timestamp() - os.path.getmtime(temp_path)
            if file_age < 1800:  # 30 minutes
                logger.info(f"[TikTok Proxy] Serving cached video: {temp_filename}")
                return FileResponse(
                    temp_path,
                    media_type="video/mp4",
                    headers={
                        'Accept-Ranges': 'bytes',
                        'Cache-Control': 'public, max-age=1800',
                    }
                )
        
        # Download the video using yt-dlp
        logger.info(f"[TikTok Proxy] Downloading video: {url}")
        result = await asyncio.to_thread(
            subprocess.run,
            [
                'yt-dlp',
                '-f', 'best[ext=mp4]/best',
                '-o', temp_path,
                '--no-playlist',
                '--no-warnings',
                '--quiet',
                '--force-overwrites',
                url
            ],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            logger.error(f"[TikTok Proxy] yt-dlp download error: {result.stderr}")
            raise HTTPException(502, "Failed to download video")
        
        if not os.path.exists(temp_path):
            logger.error(f"[TikTok Proxy] Video file not created")
            raise HTTPException(502, "Video download failed")
        
        logger.info(f"[TikTok Proxy] Serving downloaded video: {temp_filename}")
        return FileResponse(
            temp_path,
            media_type="video/mp4",
            headers={
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=1800',
            }
        )
        
    except subprocess.TimeoutExpired:
        logger.error(f"[TikTok Proxy] Timeout downloading video")
        raise HTTPException(504, "Download timeout")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TikTok Proxy] Error: {e}")
        raise HTTPException(500, "Internal error")

@app.get("/api/resolve-tiktok")
async def resolve_tiktok(url: str, req: Request):
    """Fallback: Resolve TikTok short URL to video ID for iframe embed."""
    require_session(req)
    
    if not url or 'tiktok.com' not in url.lower():
        raise HTTPException(400, "Invalid TikTok URL")
    
    if not url.startswith('http'):
        url = 'https://' + url
    
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as client:
            response = await client.get(url)
            final_url = str(response.url)
            
            match = TIKTOK_VIDEO_ID_PATTERN.search(final_url)
            if match:
                return {"videoId": match.group(1), "resolvedUrl": final_url}
            
            raise HTTPException(404, "Could not extract video ID")
    except httpx.TimeoutException:
        raise HTTPException(504, "Request timeout")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, "Internal error")

# --- WebSocket Hub with presence ---
class Hub:
    def __init__(self):
        self.rooms: Dict[str, Dict[WebSocket, str]] = {}

    async def join(self, drop_id: str, ws: WebSocket, user: str = "anon"):
        await ws.accept()
        self.rooms.setdefault(drop_id, {})[ws] = user
        
        # Send current presence state to the NEW connection only
        # Tell them who's already online (excluding themselves)
        existing_users = {}
        for conn, u in self.rooms.get(drop_id, {}).items():
            if conn != ws and u != user:  # Don't send their own presence
                existing_users[u] = True
        
        # Send initial presence of existing users to the new connection
        for existing_user in existing_users.keys():
            await ws.send_json({
                "type": "presence",
                "data": {"user": existing_user, "state": "active", "ts": int(time.time() * 1000)},
                "online": len(self.rooms.get(drop_id, {}))
            })
        
        # Then broadcast this user's join to OTHERS (not self)
        await self.broadcast_to_others(drop_id, ws, {
            "type": "presence",
            "data": {"user": user, "state": "active", "ts": int(time.time() * 1000)},
            "online": len(self.rooms.get(drop_id, {}))
        })

    async def leave(self, drop_id: str, ws: WebSocket):
        # Get user before removal
        user_label = self.rooms.get(drop_id, {}).get(ws, "anon")
        logger.info(f"[Hub.leave] User '{user_label}' disconnecting from drop '{drop_id}'")
        
        try:
            del self.rooms.get(drop_id, {})[ws]
            if not self.rooms.get(drop_id): 
                self.rooms.pop(drop_id, None)
        except KeyError:
            pass
        
        # Broadcast user's offline state
        logger.info(f"[Hub.leave] Broadcasting offline state for user '{user_label}'")
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
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.leave(drop_id, ws)

    async def broadcast_to_others(self, drop_id: str, sender_ws: WebSocket, payload: Dict[str, Any]):
        """Broadcast to all connections in room EXCEPT sender"""
        conns = list(self.rooms.get(drop_id, {}).keys())
        dead = []
        for ws in conns:
            if ws == sender_ws:
                continue
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.leave(drop_id, ws)

hub = Hub()

# --- Game State Management ---
class GameManager:
    def __init__(self):
        self.games: Dict[str, Dict[str, Any]] = {}  # gameId -> game state

    def create_game(self, drop_id: str, game_type: str, game_data: Dict[str, Any]) -> str:
        """Create a new game and return gameId"""
        import uuid
        game_id = f"game_{uuid.uuid4().hex[:12]}"
        
        self.games[game_id] = {
            "gameId": game_id,
            "dropId": drop_id,
            "gameType": game_type,
            "gameData": game_data,
            "status": "active",
            "created": int(time.time() * 1000),
            "players": []
        }
        
        logger.info(f"[Game] Created game {game_id} in drop {drop_id}")
        return game_id

    def get_game(self, game_id: str) -> Optional[Dict[str, Any]]:
        """Get game state by ID"""
        return self.games.get(game_id)

    def update_game(self, game_id: str, updates: Dict[str, Any]):
        """Update game state"""
        if game_id in self.games:
            self.games[game_id].update(updates)

    def end_game(self, game_id: str):
        """Mark game as ended"""
        if game_id in self.games:
            self.games[game_id]["status"] = "ended"

    def get_active_games(self, drop_id: str) -> List[Dict[str, Any]]:
        """Get all active games for a drop"""
        active = []
        for game_id, game in self.games.items():
            if game.get("dropId") == drop_id and game.get("status") == "active":
                active.append({
                    "gameId": game_id,
                    "gameType": game.get("gameType"),
                    "created": game.get("created"),
                    "gameData": game.get("gameData")
                })
        return active

game_manager = GameManager()

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    params = dict(ws.query_params)
    # verify session token from query
    session_token = params.get("sessionToken") or params.get("sess")
    logger.info(f"[WS] Session token received: {session_token[:20] if session_token else 'None'}...")
    if not session_token or not _verify_token(session_token):
        logger.warning(f"[WS] Invalid session token, closing connection")
        await ws.close(code=1008)
        return

    drop = params.get("drop") or params.get("dropId") or "default"
    # optional strictness via edge token
    edge = params.get("edge")
    if EDGE_AUTH_TOKEN and edge != EDGE_AUTH_TOKEN:
        await ws.close(code=4401)
        return

    user = params.get("user") or params.get("role") or "anon"
    logger.info(f"[WS] WebSocket connecting: user={user}, drop={drop}")
    await hub.join(drop, ws, user)
    try:
        while True:
            msg = await ws.receive_json()
            # Support both type/action styles
            t = msg.get("type") or msg.get("action")
            payload = msg.get("payload") or msg
            if t == "typing":
                # Add user to typing payload so recipient knows WHO is typing
                typing_payload = dict(payload or {})
                typing_payload["user"] = user
                await hub.broadcast(drop, {"type": "typing", "payload": typing_payload})
            elif t == "ping":
                await ws.send_json({"type": "pong", "ts": int(time.time()*1000)})
            elif t == "notify":
                notify(f"{msg}")
            elif t == "presence":
                # Ephemeral presence - broadcast only, no DB persistence
                try:
                    presence_payload = {
                        "user": (payload or {}).get("user") or user,
                        "state": (payload or {}).get("state", "active"),
                        "ts": (payload or {}).get("ts", int(time.time() * 1000)),
                    }
                except Exception:
                    presence_payload = {"user": user, "state": "active", "ts": int(time.time()*1000)}
                # Broadcast to all OTHER connections (not sender) - presence is ephemeral
                await hub.broadcast_to_others(drop, ws, {"type": "presence", "data": presence_payload, "online": hub._online(drop)})
            elif t == "presence_request":
                await hub.broadcast(drop, {"type": "presence_request", "data": {"ts": int(time.time() * 1000)}})
            elif t == "read":
                # Handle read receipt from client
                up_to_seq = (payload or {}).get("upToSeq")
                reader = (payload or {}).get("reader") or user
                
                logger.info(f"[READ] Received: reader={reader}, upToSeq={up_to_seq}, drop={drop}")
                
                if up_to_seq is not None:
                    now_ms = int(time.time() * 1000)
                    
                    with engine.begin() as conn:
                        # Mark messages from OTHER user as read
                        result = conn.execute(text("""
                            UPDATE messages 
                            SET read_at = :now 
                            WHERE drop_id = :d 
                              AND seq <= :seq 
                              AND user != :reader 
                              AND read_at IS NULL
                        """), {"now": now_ms, "d": drop, "seq": up_to_seq, "reader": reader})
                        
                        rows_updated = result.rowcount
                        logger.info(f"[READ] Updated {rows_updated} messages in DB")
                    
                    # ALWAYS broadcast read receipt (even if 0 rows updated)
                    # This ensures the sender gets notified
                    broadcast_data = {
                        "type": "read_receipt",
                        "data": {
                            "upToSeq": up_to_seq,
                            "reader": reader,
                            "readAt": now_ms
                        }
                    }
                    
                    num_clients = hub._online(drop)
                    logger.info(f"[READ] Broadcasting to {num_clients} clients: {broadcast_data}")
                    
                    await hub.broadcast(drop, broadcast_data)
                    
                    logger.info(f"[READ] Broadcast complete")
                else:
                    logger.warning(f"[READ] Skipped: upToSeq is None")
            elif t == "chat":
                # Text message via WebSocket
                text_val = (payload or {}).get("text") or ""
                msg_user = (payload or {}).get("user") or user
                client_id = (payload or {}).get("clientId")
                reply_to_seq = (payload or {}).get("replyToSeq")
                
                if not text_val:
                    await ws.send_json({"type": "error", "error": "text required"})
                    continue
                
                # Insert into DB
                ts = int(time.time() * 1000)
                msg_id = secrets.token_hex(8)
                
                with engine.begin() as conn:
                    row = conn.execute(text("select coalesce(max(seq),0)+1 as next from messages where drop_id=:d"), {"d": drop}).mappings().first()
                    next_seq = int(row["next"]) if row else 1
                    
                    conn.execute(text("""
                        insert into messages(id,drop_id,seq,ts,created_at,updated_at,user,client_id,message_type,text,reactions,reply_to_seq,delivered_at)
                        values(:id,:d,:seq,:ts,:ca,:ua,:u,:cid,:mt,:tx,:rx,:rts,:del)
                    """), {
                        "id": msg_id, "d": drop, "seq": next_seq, "ts": ts,
                        "ca": ts, "ua": ts, "u": msg_user, "cid": client_id,
                        "mt": "text", "tx": text_val, "rx": "{}",
                        "rts": reply_to_seq, "del": ts
                    })
                
                # Cleanup old messages (keep only 30 most recent)
                cleanup_old_messages(drop, keep_count=30)
                
                # Update streak and broadcast if changed
                user_normalized = (msg_user or "").strip() or "E"
                streak_result = update_streak_on_message(drop, user_normalized)
                
                if streak_result["changed"]:
                    streak_data = get_streak(drop)
                    await hub.broadcast(drop, {
                        "type": "streak",
                        "data": streak_data
                    })
                
                # Build the drop payload manually instead of calling list_messages()
                # (list_messages requires req parameter for session validation)
                with engine.begin() as conn:
                    rows = conn.execute(text("select * from messages where drop_id=:d order by seq"), {"d": drop}).mappings().all()
                
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
                    }
                    if o.get("blob_id"):
                        msg["img"] = f"/blob/{o['blob_id']}"
                        images.append({
                            "imageId": o["blob_id"],
                            "mime": o.get("mime"),
                            "originalUrl": msg["img"],
                            "thumbUrl": msg["img"],
                            "uploadedAt": o.get("ts"),
                        })
                    out.append(msg)
                
                full_drop = {"dropId": drop, "version": int(next_seq), "messages": out, "images": images}
                
                # Broadcast update WITH FULL DATA to all connections
                await hub.broadcast(drop, {"type": "update", "data": full_drop})
                
                # Notify if E posts, debounced
                if (msg_user or "").upper() == "E" and _should_notify("msg", drop, 60):
                    notify("E posted a new message")
            elif t == "gif":
                # GIF message via WebSocket
                gif_url = (payload or {}).get("gifUrl")
                gif_preview = (payload or {}).get("gifPreview")
                gif_width = (payload or {}).get("gifWidth", 0)
                gif_height = (payload or {}).get("gifHeight", 0)
                title = (payload or {}).get("title") or "[GIF]"
                msg_user = (payload or {}).get("user") or user
                client_id = (payload or {}).get("clientId")
                
                if not gif_url:
                    await ws.send_json({"type": "error", "error": "gifUrl required"})
                    continue
                
                # Insert into DB
                ts = int(time.time() * 1000)
                msg_id = secrets.token_hex(8)
                
                with engine.begin() as conn:
                    row = conn.execute(text("select coalesce(max(seq),0)+1 as next from messages where drop_id=:d"), {"d": drop}).mappings().first()
                    next_seq = int(row["next"]) if row else 1
                    
                    conn.execute(text("""
                        insert into messages(id,drop_id,seq,ts,created_at,updated_at,user,client_id,message_type,text,reactions,gif_url,gif_preview,gif_width,gif_height)
                        values(:id,:d,:seq,:ts,:ca,:ua,:u,:cid,:mt,:tx,:rx,:gurl,:gprev,:gw,:gh)
                    """), {
                        "id": msg_id, "d": drop, "seq": next_seq, "ts": ts,
                        "ca": ts, "ua": ts, "u": msg_user, "cid": client_id,
                        "mt": "gif", "tx": f"[GIF: {title}]", "rx": "{}",
                        "gurl": gif_url, "gprev": gif_preview, "gw": gif_width, "gh": gif_height
                    })
                
                # Cleanup old messages (keep only 30 most recent)
                cleanup_old_messages(drop, keep_count=30)
                
                # Update streak and broadcast if changed
                user_normalized = (msg_user or "").strip() or "E"
                streak_result = update_streak_on_message(drop, user_normalized)
                
                if streak_result["changed"]:
                    streak_data = get_streak(drop)
                    await hub.broadcast(drop, {
                        "type": "streak",
                        "data": streak_data
                    })
                
                # Build the drop payload manually instead of calling list_messages()
                # (list_messages requires req parameter for session validation)
                with engine.begin() as conn:
                    rows = conn.execute(text("select * from messages where drop_id=:d order by seq"), {"d": drop}).mappings().all()
                
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
                    }
                    if o.get("blob_id"):
                        msg["img"] = f"/blob/{o['blob_id']}"
                        images.append({
                            "imageId": o["blob_id"],
                            "mime": o.get("mime"),
                            "originalUrl": msg["img"],
                            "thumbUrl": msg["img"],
                            "uploadedAt": o.get("ts"),
                        })
                    out.append(msg)
                
                full_drop = {"dropId": drop, "version": int(next_seq), "messages": out, "images": images}
                
                # Broadcast update WITH FULL DATA to all connections
                await hub.broadcast(drop, {"type": "update", "data": full_drop})
                
                # Notify if E posts, debounced
                if (msg_user or "").upper() == "E" and _should_notify("gif", drop, 60):
                    notify("E sent a GIF")
            elif t == "game":
                # Enhanced game event handling with state management
                op = (payload or {}).get("op")
                logger.info(f"[Game] Received op={op} from user={user}")
                
                if op == "start":
                    # Create new game
                    game_type = payload.get("gameType", "t3")
                    game_data = payload.get("gameData", {})
                    
                    game_id = game_manager.create_game(drop, game_type, game_data)
                    
                    # Broadcast 'started' event to all players
                    await hub.broadcast(drop, {
                        "type": "game",
                        "payload": {
                            "op": "started",
                            "gameId": game_id,
                            "gameType": game_type,
                            "gameData": game_data
                        }
                    })
                    
                    logger.info(f"[Game] Started game {game_id} with starter={game_data.get('starter')}")
                    
                    # Notify when E starts a game, debounced
                    try:
                        if (user or "").upper() == "E" and _should_notify("game", drop, 60):
                            notify("E started a game")
                    except Exception:
                        pass
                
                elif op == "join":
                    # Join existing game
                    game_id = payload.get("gameId")
                    game = game_manager.get_game(game_id)
                    
                    if game:
                        # Add player to game if not already in
                        if user not in game.get("players", []):
                            game["players"].append(user)
                            game_manager.update_game(game_id, {"players": game["players"]})
                        
                        # Broadcast 'joined' event
                        await hub.broadcast(drop, {
                            "type": "game",
                            "payload": {
                                "op": "joined",
                                "gameId": game_id,
                                "gameType": game.get("gameType"),
                                "gameData": game.get("gameData"),
                                "player": user
                            }
                        })
                        
                        logger.info(f"[Game] Player {user} joined game {game_id}")
                    else:
                        # Game not found
                        await ws.send_json({
                            "type": "error",
                            "message": f"Game {game_id} not found"
                        })
                
                elif op == "move":
                    # Process move
                    game_id = payload.get("gameId")
                    move_data = payload.get("moveData", {})
                    
                    game = game_manager.get_game(game_id)
                    if game:
                        # Update game state with move
                        game_data = game.get("gameData", {})
                        
                        # Apply move to board
                        if "board" not in game_data:
                            game_data["board"] = [[None,None,None],[None,None,None],[None,None,None]]
                        
                        r = move_data.get("r")
                        c = move_data.get("c")
                        mover = move_data.get("by")
                        
                        # ✅ Get marker from moveData, or calculate it from starter
                        marker = move_data.get("marker")
                        if not marker and mover:
                            # Starter is X, non-starter is O
                            starter = game_data.get("starter")
                            marker = "X" if mover == starter else "O"
                            logger.info(f"[Game] Calculated marker {marker} for {mover} (starter={starter})")
                        
                        # ✅ Get nextTurn from moveData, or calculate it
                        next_turn = move_data.get("nextTurn")
                        if not next_turn and mover:
                            # Switch turns
                            next_turn = "M" if mover == "E" else "E"
                            logger.info(f"[Game] Calculated nextTurn {next_turn} after {mover}")
                        
                        # ✅ Update board if we have all required data
                        if r is not None and c is not None and marker:
                            logger.info(f"[Game] Applying move to board: r={r}, c={c}, marker={marker}, nextTurn={next_turn}")
                            game_data["board"][r][c] = marker
                            if next_turn:
                                game_data["currentTurn"] = next_turn
                            
                            # ✅ CRITICAL: Update the game with new gameData
                            game_manager.update_game(game_id, {"gameData": game_data})
                            
                            logger.info(f"[Game] Updated board state: {game_data['board']}")
                        else:
                            logger.error(f"[Game] Invalid move data: r={r}, c={c}, marker={marker}")
                        
                        # Broadcast move to all players with UPDATED gameData
                        await hub.broadcast(drop, {
                            "type": "game",
                            "payload": {
                                "op": "move",
                                "gameId": game_id,
                                "moveData": move_data,
                                "gameData": game_data  # ✅ Send updated board state
                            }
                        })
                        
                        logger.info(f"[Game] Broadcasted move in game {game_id}: {move_data}")
                
                elif op == "end_game":
                    # End game
                    game_id = payload.get("gameId")
                    result = payload.get("result")
                    
                    game_manager.end_game(game_id)
                    
                    # Broadcast end event
                    await hub.broadcast(drop, {
                        "type": "game",
                        "payload": {
                            "op": "game_ended",
                            "gameId": game_id,
                            "result": result
                        }
                    })
                    
                    logger.info(f"[Game] Game {game_id} ended with result: {result}")
                
                elif op == "request_game_list":
                    # Send active games list to requester
                    active_games = game_manager.get_active_games(drop)
                    
                    await ws.send_json({
                        "type": "game_list",
                        "data": {
                            "games": active_games
                        }
                    })
                    
                    logger.info(f"[Game] Sent {len(active_games)} active games to {user}")
                
                elif op in ["player_opened", "player_closed"]:
                    # Broadcast player presence in game
                    await hub.broadcast(drop, {
                        "type": "game",
                        "payload": payload
                    })
                    
                    logger.info(f"[Game] Player {user} {op} game {payload.get('gameId')}")
                
                else:
                    # Unknown game operation - passthrough for backward compatibility
                    await hub.broadcast(drop, {"type": "game", "payload": payload})
                    logger.warning(f"[Game] Unknown game operation: {op}")
            else:
                # Unrecognized events are ignored
                pass
    except WebSocketDisconnect:
        await hub.leave(drop, ws)

# --- Static UI: serve /msgdrop
app.mount("/msgdrop", StaticFiles(directory="html", html=True), name="msgdrop")
# Also serve common asset roots for absolute paths the UI may use
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
    # SSL paths from environment
    ssl_cert = os.environ.get("SSL_CERT_PATH")
    ssl_key = os.environ.get("SSL_KEY_PATH")
    port = int(os.environ.get("PORT", "443"))

    try:
        cert_exists = ssl_cert and Path(ssl_cert).exists()
        key_exists = ssl_key and Path(ssl_key).exists()
    except Exception:
        cert_exists = key_exists = False

    if cert_exists and key_exists:
        logger.info(f"Starting with SSL on port {port}")
        uvicorn.run(
            app,
            host="0.0.0.0",
            port=port,
            ssl_certfile=ssl_cert,
            ssl_keyfile=ssl_key,
            proxy_headers=True,
        )
    else:
        logger.info(f"Starting without SSL on port {port}")
        uvicorn.run(app, host="0.0.0.0", port=port, proxy_headers=True)
