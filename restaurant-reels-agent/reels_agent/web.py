"""Local web studio: upload photos, point at music, render and watch the reel.

    python -m reels_agent web        ->  http://127.0.0.1:5000

Everything runs on your machine; the page is not meant to be exposed to the internet.
"""
from __future__ import annotations

import json
import logging
import shutil
import threading
import traceback
import uuid
from datetime import date
from pathlib import Path

from flask import Flask, Response, abort, jsonify, request, send_file

from .caption import CaptionResult, generate_caption, template_caption
from .config import Config, load_config
from .intake import IMAGE_EXTS
from .music import choose_music, fetch_track, list_tracks
from .pipeline import publish_reel, render_reel

log = logging.getLogger(__name__)

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


def job_dir(cfg: Config, job_id: str) -> Path:
    return cfg.paths.state / "web" / job_id


def set_job(job_id: str, **fields) -> None:
    with JOBS_LOCK:
        JOBS.setdefault(job_id, {}).update(fields)


def add_log(job_id: str, line: str) -> None:
    with JOBS_LOCK:
        JOBS.setdefault(job_id, {}).setdefault("log", []).append(line)
    log.info("[%s] %s", job_id[:6], line)


def _render_job(cfg: Config, job_id: str, options: dict) -> None:
    """Runs in a background thread: caption -> music -> render."""
    d = job_dir(cfg, job_id)
    photos = sorted((d / "photos").iterdir(), key=lambda p: p.name)
    try:
        set_job(job_id, status="running")
        add_log(job_id, f"{len(photos)} תמונות התקבלו")

        cfg.video.seconds_per_photo = float(options.get("seconds_per_photo") or cfg.video.seconds_per_photo)
        cfg.video.layout = options.get("layout") or cfg.video.layout
        cfg.music.volume = float(options.get("volume") or cfg.music.volume)
        cfg.music.start_seconds = float(options.get("music_start") or 0)
        if options.get("restaurant_name"):
            cfg.restaurant.name = options["restaurant_name"]
        if options.get("handle"):
            cfg.restaurant.handle = options["handle"]

        # --- caption
        edited = options.get("caption_override")
        if edited:
            caption = CaptionResult(**{**edited, "source": "edited"})
            add_log(job_id, "משתמש בטקסטים שערכת")
        elif options.get("use_ai"):
            add_log(job_id, "Claude מסתכל בתמונות וכותב טקסטים...")
            caption = generate_caption(cfg, photos, options.get("notes", ""), date.today())
            add_log(job_id, f"נכתב על ידי {caption.source}")
            if caption.source == "template":
                add_log(job_id, "⚠️ לא הצלחתי להשתמש ב-Claude (חסר ANTHROPIC_API_KEY?) - נעשה שימוש בתבנית")
        else:
            caption = template_caption(cfg, len(photos))
            add_log(job_id, "טקסטים מתבנית (בלי Claude)")

        # --- music
        music: Path | None = None
        mdir = d / "music"
        chosen = options.get("music_choice", "auto")
        if chosen == "none":
            cfg.music.enabled = False
            add_log(job_id, "בלי מוזיקה")
        elif chosen == "upload":
            files = sorted(mdir.glob("*")) if mdir.is_dir() else []
            if files:
                music = files[0]
                add_log(job_id, f"מוזיקה: {music.name}")
        elif chosen == "url" and options.get("music_url"):
            add_log(job_id, "מוריד את המוזיקה מהקישור...")
            try:
                music = fetch_track(options["music_url"], mdir)
                add_log(job_id, f"מוזיקה: {music.name}")
            except Exception as e:
                add_log(job_id, f"⚠️ הורדת המוזיקה נכשלה: {e}")
        elif chosen.startswith("library:"):
            name = chosen.split(":", 1)[1]
            for t in list_tracks(cfg):
                if t.name == name:
                    music = t
                    add_log(job_id, f"מוזיקה מהספרייה: {t.name}")

        if music is None and cfg.music.enabled:
            estimate = (cfg.video.intro_seconds + cfg.video.outro_seconds
                        + len(photos) * cfg.video.seconds_per_photo)
            music = choose_music(cfg, estimate, mdir, seed=job_id)
            if music:
                add_log(job_id, f"מוזיקה: {music.name}")

        # --- render
        add_log(job_id, "מרנדר את הרילס...")
        video, cover, duration = render_reel(cfg, photos, caption, date.today(),
                                             workdir=d / "work", music=music, out_dir=d / "out")
        add_log(job_id, f"מוכן: {duration:.1f} שניות")
        set_job(job_id, status="done", video=str(video), cover=str(cover), duration=duration,
                caption=caption.to_dict(), caption_text=caption.full_caption())
    except Exception as e:
        log.exception("Render job failed")
        add_log(job_id, f"❌ {e}")
        set_job(job_id, status="error", error=str(e), trace=traceback.format_exc()[-2000:])


def create_app(cfg: Config) -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 256 * 1024 * 1024

    @app.get("/")
    def index() -> Response:
        return Response(PAGE, mimetype="text/html; charset=utf-8")

    @app.get("/api/setup")
    def setup() -> Response:
        import os

        from .storage import NoStorage, get_storage
        try:
            storage_ok = not isinstance(get_storage(cfg), NoStorage)
        except Exception:
            storage_ok = False
        return jsonify({
            "restaurant": cfg.restaurant.name,
            "handle": cfg.restaurant.handle,
            "seconds_per_photo": cfg.video.seconds_per_photo,
            "layout": cfg.video.layout,
            "volume": cfg.music.volume,
            "tracks": [t.name for t in list_tracks(cfg)],
            "has_claude": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "can_publish": storage_ok and bool(cfg.instagram.user_id and cfg.instagram.access_token),
        })

    @app.post("/api/render")
    def render() -> Response:
        job_id = uuid.uuid4().hex[:12]
        d = job_dir(cfg, job_id)
        (d / "photos").mkdir(parents=True, exist_ok=True)
        files = request.files.getlist("photos")
        if not files:
            return jsonify({"error": "לא נבחרו תמונות"}), 400
        for i, f in enumerate(files):
            ext = Path(f.filename or "").suffix.lower()
            if ext not in IMAGE_EXTS:
                continue
            f.save(d / "photos" / f"{i:03d}{ext}")
        if not any((d / "photos").iterdir()):
            return jsonify({"error": "לא נמצאו קובצי תמונה נתמכים"}), 400

        options = json.loads(request.form.get("options", "{}"))
        mfile = request.files.get("music_file")
        if mfile and mfile.filename:
            (d / "music").mkdir(parents=True, exist_ok=True)
            mfile.save(d / "music" / Path(mfile.filename).name)

        set_job(job_id, status="queued", log=[], options=options)
        threading.Thread(target=_render_job, args=(cfg, job_id, options), daemon=True).start()
        return jsonify({"job": job_id})

    @app.post("/api/rerender/<job_id>")
    def rerender(job_id: str) -> Response:
        with JOBS_LOCK:
            old = dict(JOBS.get(job_id) or {})
        if not old:
            abort(404)
        options = {**old.get("options", {}), **request.get_json(force=True)}
        set_job(job_id, status="queued", log=[], options=options)
        threading.Thread(target=_render_job, args=(cfg, job_id, options), daemon=True).start()
        return jsonify({"job": job_id})

    @app.get("/api/job/<job_id>")
    def job(job_id: str) -> Response:
        with JOBS_LOCK:
            j = dict(JOBS.get(job_id) or {})
        if not j:
            abort(404)
        j.pop("options", None)
        if j.get("video"):
            j["video_url"] = f"/media/{job_id}/video"
            j["cover_url"] = f"/media/{job_id}/cover"
            j.pop("video", None)
            j.pop("cover", None)
        return jsonify(j)

    @app.get("/media/<job_id>/<kind>")
    def media(job_id: str, kind: str) -> Response:
        with JOBS_LOCK:
            j = dict(JOBS.get(job_id) or {})
        path = j.get("video" if kind == "video" else "cover")
        if not path or not Path(path).is_file():
            abort(404)
        return send_file(path, conditional=True,
                         mimetype="video/mp4" if kind == "video" else "image/jpeg")

    @app.post("/api/publish/<job_id>")
    def publish(job_id: str) -> Response:
        with JOBS_LOCK:
            j = dict(JOBS.get(job_id) or {})
        if j.get("status") != "done":
            return jsonify({"error": "אין רילס מוכן"}), 400
        text = (request.get_json(silent=True) or {}).get("caption") or j.get("caption_text", "")
        try:
            result, url = publish_reel(cfg, Path(j["video"]), text, Path(j["cover"]))
            set_job(job_id, published=result)
            return jsonify(result)
        except Exception as e:
            log.exception("Publish from web failed")
            return jsonify({"error": str(e)}), 500

    @app.post("/api/cleanup/<job_id>")
    def cleanup(job_id: str) -> Response:
        shutil.rmtree(job_dir(cfg, job_id), ignore_errors=True)
        with JOBS_LOCK:
            JOBS.pop(job_id, None)
        return jsonify({"ok": True})

    return app


def serve(cfg: Config, host: str = "127.0.0.1", port: int = 5000, debug: bool = False) -> None:
    app = create_app(cfg)
    print(f"\n  🍽️  Reels Studio  ->  http://{host}:{port}\n")
    app.run(host=host, port=port, debug=debug, threaded=True)


PAGE = r"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reels Studio</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>%F0%9F%8D%BD</text></svg>">
<style>
  :root{
    --bg:#17110d; --panel:#211812; --panel-2:#2b201a; --line:#3b2c23;
    --text:#f6efe8; --muted:#b4a294; --gold:#f2c14e; --green:#7fc08a; --red:#e07a6a;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:15px/1.55 "Segoe UI",Rubik,Arial,Helvetica,sans-serif}
  a{color:var(--gold)}
  header{padding:22px 26px;border-bottom:1px solid var(--line);
         display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  header h1{font-size:20px;margin:0;font-weight:700}
  header .sub{color:var(--muted);font-size:13px}
  .badge{font-size:12px;padding:3px 10px;border-radius:20px;background:var(--panel-2);
         border:1px solid var(--line);color:var(--muted)}
  .badge.on{color:var(--green);border-color:#3f5f45}
  .wrap{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:22px;padding:22px;
        max-width:1280px;margin:0 auto}
  @media(max-width:960px){.wrap{grid-template-columns:1fr}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:18px}
  .card h2{font-size:15px;margin:0 0 14px;display:flex;align-items:center;gap:8px}
  .card h2 .n{width:22px;height:22px;border-radius:50%;background:var(--gold);color:#2a1c0c;
              font-size:12px;display:grid;place-items:center;font-weight:700}
  label{display:block;font-size:13px;color:var(--muted);margin:10px 0 5px}
  input[type=text],input[type=url],input[type=number],select,textarea{
    width:100%;background:var(--panel-2);border:1px solid var(--line);color:var(--text);
    border-radius:10px;padding:9px 11px;font:inherit;font-size:14px}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--gold)}
  textarea{resize:vertical;min-height:64px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .drop{border:2px dashed var(--line);border-radius:14px;padding:26px;text-align:center;
        color:var(--muted);cursor:pointer;transition:.15s}
  .drop:hover,.drop.over{border-color:var(--gold);color:var(--text);background:#241a14}
  .drop b{color:var(--gold)}
  .thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px;margin-top:14px}
  .thumb{position:relative;border-radius:10px;overflow:hidden;aspect-ratio:1;background:#000;
         border:1px solid var(--line)}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .thumb .idx{position:absolute;inset-inline-start:5px;top:5px;background:rgba(0,0,0,.72);
              border-radius:6px;font-size:11px;padding:1px 6px}
  .thumb .ops{position:absolute;inset-inline:0;bottom:0;display:flex;background:rgba(0,0,0,.72)}
  .thumb .ops button{flex:1;background:none;border:0;color:#fff;cursor:pointer;font-size:14px;padding:3px}
  .thumb .ops button:hover{background:rgba(255,255,255,.18)}
  .opts{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}
  .opt{padding:7px 13px;border-radius:20px;border:1px solid var(--line);background:var(--panel-2);
       cursor:pointer;font-size:13px}
  .opt.sel{border-color:var(--gold);background:#3a2a12;color:var(--gold)}
  .hint{font-size:12px;color:var(--muted);margin-top:7px}
  .go{width:100%;padding:14px;border:0;border-radius:12px;background:var(--gold);color:#2a1c0c;
      font-size:16px;font-weight:700;cursor:pointer}
  .go:disabled{opacity:.5;cursor:not-allowed}
  .side{position:sticky;top:22px;align-self:start}
  .phone{aspect-ratio:9/16;border-radius:20px;overflow:hidden;background:#000;border:1px solid var(--line);
         display:grid;place-items:center;position:relative}
  .phone video{width:100%;height:100%;display:block;object-fit:contain;background:#000}
  .ph-empty{color:var(--muted);font-size:13px;text-align:center;padding:24px}
  .logbox{background:#120d09;border:1px solid var(--line);border-radius:10px;padding:11px;
          font-size:12.5px;max-height:180px;overflow:auto;white-space:pre-wrap;margin-top:12px;
          font-family:ui-monospace,Menlo,Consolas,monospace;direction:rtl}
  .btns{display:flex;gap:9px;margin-top:12px;flex-wrap:wrap}
  .btn{flex:1;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--panel-2);
       color:var(--text);cursor:pointer;font:inherit;font-size:13.5px;text-align:center;text-decoration:none}
  .btn:hover{border-color:var(--gold)}
  .btn.pri{background:var(--gold);color:#2a1c0c;border-color:var(--gold);font-weight:700}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .spin{width:30px;height:30px;border:3px solid var(--line);border-top-color:var(--gold);
        border-radius:50%;animation:sp 1s linear infinite;margin:0 auto 12px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .err{background:#3a1c1c;border:1px solid #6b3030;border-radius:10px;padding:11px;font-size:13px;margin-top:12px}
  .ok{background:#1d3324;border:1px solid #3f6b48;border-radius:10px;padding:11px;font-size:13px;margin-top:12px}
  .lbl-row{display:flex;gap:8px;align-items:center;margin-bottom:7px}
  .lbl-row img{width:38px;height:38px;object-fit:cover;border-radius:7px;flex:none}
  .lbl-row input{flex:1}
  details summary{cursor:pointer;color:var(--muted);font-size:13px;margin-top:6px}
</style>
</head>
<body>
<header>
  <h1>🍽️ Reels Studio</h1>
  <span class="sub" id="rest"></span>
  <span style="flex:1"></span>
  <span class="badge" id="b-claude">Claude</span>
  <span class="badge" id="b-ig">Instagram</span>
</header>

<div class="wrap">
  <div>
    <div class="card">
      <h2><span class="n">1</span> תמונות של היום</h2>
      <div class="drop" id="drop">
        גררו לכאן תמונות או <b>לחצו לבחירה</b><br>
        <span class="hint">הסדר בסרטון הוא הסדר כאן. עד 10 תמונות.</span>
      </div>
      <input type="file" id="files" accept="image/*" multiple hidden>
      <div class="thumbs" id="thumbs"></div>
    </div>

    <div class="card">
      <h2><span class="n">2</span> מוזיקה</h2>
      <div class="opts" id="music-opts">
        <div class="opt sel" data-m="auto">אוטומטי</div>
        <div class="opt" data-m="url">קישור</div>
        <div class="opt" data-m="upload">העלאת קובץ</div>
        <div class="opt" data-m="none">בלי מוזיקה</div>
      </div>
      <div id="m-auto"><p class="hint">רצועה אקראית מ-<code>assets/music/</code>. אם ריק, מסונתז פאד עדין.</p>
        <select id="track"></select></div>
      <div id="m-url" hidden>
        <label>קישור לקובץ אודיו (mp3/m4a/wav) או לעמוד וידאו (דורש yt-dlp)</label>
        <input type="url" id="music_url" placeholder="https://example.com/track.mp3" dir="ltr">
        <p class="hint">⚠️ ודאו שיש לכם זכויות לשימוש מסחרי במוזיקה. אינסטגרם מורידה רילסים עם מוזיקה לא מורשית.</p>
      </div>
      <div id="m-upload" hidden>
        <label>קובץ מוזיקה מהמחשב</label>
        <input type="file" id="music_file" accept="audio/*">
      </div>
      <div class="row" style="margin-top:12px">
        <div><label>עוצמה</label><input type="number" id="volume" step="0.1" min="0" max="1.5" value="0.8"></div>
        <div><label>להתחיל מהשנייה</label><input type="number" id="music_start" step="1" min="0" value="0"></div>
      </div>
    </div>

    <div class="card">
      <h2><span class="n">3</span> עיצוב וטקסטים</h2>
      <div class="row">
        <div><label>שם המסעדה</label><input type="text" id="name"></div>
        <div><label>Handle</label><input type="text" id="handle" dir="ltr" placeholder="@myrestaurant"></div>
      </div>
      <div class="row">
        <div><label>שניות לכל תמונה</label><input type="number" id="spp" step="0.5" min="1.5" max="8" value="3.5"></div>
        <div><label>פריסה</label>
          <select id="layout">
            <option value="auto">אוטומטי</option>
            <option value="cover">מסך מלא</option>
            <option value="card">כרטיס על רקע מטושטש</option>
          </select></div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--text)">
        <input type="checkbox" id="use_ai" checked style="width:auto"> שיהיה Claude יכתוב את הטקסטים לפי התמונות
      </label>
      <label>הערות להיום (אופציונלי)</label>
      <textarea id="notes" placeholder="למשל: היום מבצע על סלט קיסר, הדגים טריים מהבוקר"></textarea>
    </div>

    <button class="go" id="go">✨ צור רילס</button>
  </div>

  <div class="side">
    <div class="card">
      <div class="phone" id="phone"><div class="ph-empty" id="ph-empty">התצוגה המקדימה תופיע כאן</div></div>
      <div class="logbox" id="log" hidden></div>
      <div id="result" hidden>
        <div class="btns">
          <a class="btn" id="dl" download>⬇️ הורדה</a>
          <button class="btn pri" id="pub">📸 פרסום לאינסטגרם</button>
        </div>
        <details open style="margin-top:14px">
          <summary>עריכת הטקסטים ורינדור מחדש</summary>
          <label>משפט פתיחה</label><input type="text" id="e-hook">
          <label>שמות המנות</label><div id="e-labels"></div>
          <label>משפט סיום</label><input type="text" id="e-outro">
          <label>כיתוב לאינסטגרם</label><textarea id="e-caption" style="min-height:110px"></textarea>
          <label>האשטגים</label><input type="text" id="e-tags" dir="ltr">
          <button class="btn pri" id="again" style="margin-top:12px;width:100%">🔄 רנדר מחדש עם העריכות</button>
        </details>
      </div>
      <div id="msg"></div>
    </div>
  </div>
</div>

<script>
const $ = s => document.querySelector(s);
let photos = [], job = null, setup = {}, lastCap = null;

fetch('/api/setup').then(r => r.json()).then(s => {
  setup = s;
  $('#rest').textContent = s.restaurant + (s.handle ? ' · ' + s.handle : '');
  $('#name').value = s.restaurant; $('#handle').value = s.handle;
  $('#spp').value = s.seconds_per_photo; $('#layout').value = s.layout; $('#volume').value = s.volume;
  const t = $('#track');
  t.innerHTML = '<option value="auto">רצועה אקראית</option>' +
    s.tracks.map(n => `<option value="library:${n}">${n}</option>`).join('');
  t.hidden = !s.tracks.length;
  const bc = $('#b-claude'), bi = $('#b-ig');
  bc.textContent = s.has_claude ? '✓ Claude מחובר' : 'Claude לא מוגדר';
  bc.classList.toggle('on', s.has_claude);
  $('#use_ai').checked = s.has_claude;
  bi.textContent = s.can_publish ? '✓ Instagram מחובר' : 'Instagram לא מוגדר';
  bi.classList.toggle('on', s.can_publish);
});

// ---- photos
const drop = $('#drop'), fileInput = $('#files');
drop.onclick = () => fileInput.click();
fileInput.onchange = e => addFiles(e.target.files);
['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.add('over');
}));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.remove('over');
}));
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));

function addFiles(list) {
  for (const f of list) if (f.type.startsWith('image/') && photos.length < 10) photos.push(f);
  drawThumbs();
}
function drawThumbs() {
  $('#thumbs').innerHTML = '';
  photos.forEach((f, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = `<img src="${URL.createObjectURL(f)}"><span class="idx">${i+1}</span>
      <div class="ops"><button data-a="r">→</button><button data-a="x">✕</button><button data-a="l">←</button></div>`;
    d.querySelectorAll('button').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'x') photos.splice(i, 1);
      else { const j = a === 'l' ? i - 1 : i + 1;
             if (j >= 0 && j < photos.length) [photos[i], photos[j]] = [photos[j], photos[i]]; }
      drawThumbs();
    });
    $('#thumbs').appendChild(d);
  });
}

// ---- music mode
let musicMode = 'auto';
document.querySelectorAll('#music-opts .opt').forEach(o => o.onclick = () => {
  document.querySelectorAll('#music-opts .opt').forEach(x => x.classList.remove('sel'));
  o.classList.add('sel'); musicMode = o.dataset.m;
  ['auto','url','upload'].forEach(m => $('#m-' + m).hidden = (m !== musicMode));
});

// ---- render
$('#go').onclick = async () => {
  if (!photos.length) return show('err', 'צריך לפחות תמונה אחת');
  const fd = new FormData();
  photos.forEach(f => fd.append('photos', f));
  const mf = $('#music_file').files[0];
  if (musicMode === 'upload' && mf) fd.append('music_file', mf);
  fd.append('options', JSON.stringify({
    music_choice: musicMode === 'auto' ? $('#track').value : musicMode,
    music_url: $('#music_url').value, volume: $('#volume').value, music_start: $('#music_start').value,
    seconds_per_photo: $('#spp').value, layout: $('#layout').value,
    restaurant_name: $('#name').value, handle: $('#handle').value,
    use_ai: $('#use_ai').checked, notes: $('#notes').value
  }));
  busy(true);
  const r = await fetch('/api/render', {method: 'POST', body: fd});
  const d = await r.json();
  if (d.error) { busy(false); return show('err', d.error); }
  job = d.job; poll();
};

$('#again').onclick = async () => {
  if (!job) return;
  busy(true);
  const r = await fetch('/api/rerender/' + job, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({caption_override: {
      hook: $('#e-hook').value, outro: $('#e-outro').value, caption: $('#e-caption').value,
      dish_labels: [...document.querySelectorAll('#e-labels input')].map(i => i.value),
      hashtags: $('#e-tags').value.split(/\s+/).filter(Boolean)
    }})
  });
  await r.json(); poll();
};

function busy(on) {
  $('#go').disabled = on; $('#log').hidden = !on; $('#msg').innerHTML = '';
  if (on) { $('#result').hidden = true;
            $('#phone').innerHTML = '<div class="ph-empty"><div class="spin"></div>מכין את הרילס...</div>'; }
}

async function poll() {
  const r = await fetch('/api/job/' + job);
  const d = await r.json();
  $('#log').textContent = (d.log || []).join('\n');
  $('#log').scrollTop = 1e6;
  if (d.status === 'done') return done(d);
  if (d.status === 'error') { busy(false); $('#log').hidden = false;
                              return show('err', d.error || 'הרינדור נכשל'); }
  setTimeout(poll, 900);
}

function done(d) {
  $('#go').disabled = false;
  $('#phone').innerHTML = `<video src="${d.video_url}?t=${Date.now()}" poster="${d.cover_url}?t=${Date.now()}"
      controls autoplay muted loop playsinline></video>`;
  $('#dl').href = d.video_url;
  $('#dl').setAttribute('download', 'reel.mp4');
  $('#result').hidden = false;
  $('#pub').disabled = !setup.can_publish;
  $('#pub').title = setup.can_publish ? '' : 'צריך להגדיר Instagram + אחסון ב-config.toml';
  lastCap = d.caption;
  $('#e-hook').value = d.caption.hook;
  $('#e-outro').value = d.caption.outro;
  $('#e-caption').value = d.caption.caption;
  $('#e-tags').value = (d.caption.hashtags || []).join(' ');
  $('#e-labels').innerHTML = '';
  (d.caption.dish_labels || []).forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'lbl-row';
    row.innerHTML = `<img src="${photos[i] ? URL.createObjectURL(photos[i]) : ''}"><input type="text" value="${(l||'').replace(/"/g,'&quot;')}">`;
    $('#e-labels').appendChild(row);
  });
  show('ok', `מוכן · ${d.duration.toFixed(1)} שניות`);
}

$('#pub').onclick = async () => {
  if (!confirm('לפרסם את הרילס לאינסטגרם עכשיו?')) return;
  $('#pub').disabled = true; show('ok', 'מעלה ומפרסם... זה יכול לקחת דקה');
  const tags = $('#e-tags').value;
  const caption = $('#e-caption').value + '\n.\n.\n' + tags;
  const r = await fetch('/api/publish/' + job, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({caption})});
  const d = await r.json();
  $('#pub').disabled = false;
  if (d.error) return show('err', d.error);
  show('ok', `פורסם! <a href="${d.permalink}" target="_blank">${d.permalink || d.media_id}</a>`);
};

function show(kind, html) { $('#msg').innerHTML = `<div class="${kind}">${html}</div>`; }
</script>
</body>
</html>
"""
