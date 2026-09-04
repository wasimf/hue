# 🍽️ Restaurant Reels Agent

סוכן שמקבל כל יום תמונות של המנות והסלטים מהמסעדה, מעצב מהן רילס אנכי (9:16) עם
כרטיס פתיחה, שם לכל מנה, תנועה עדינה (Ken Burns), מעברים ומוזיקת רקע, כותב כיתוב
והאשטגים בעברית עם Claude, ומעלה את הרילס לחשבון האינסטגרם של המסעדה.

```
📱 תמונות (טלגרם / תיקייה)  ──►  🤖 Claude: שם לכל מנה + כיתוב + האשטגים
                                   │
                                   ▼
                             🎬 ffmpeg + Pillow: רילס 1080x1920 עם מוזיקה
                                   │
                                   ▼
                       ☁️ העלאה ל-URL ציבורי  ──►  📸 Instagram Graph API (Reels)
```

## מה מקבלים

- **כרטיס פתיחה** עם שם המסעדה, תאריך בעברית ומשפט פתיחה שנכתב לפי התמונות.
- **כל תמונה** מקבלת תנועה עדינה (זום/פאן), מעבר חלק, ותווית עם שם המנה + לוגו/‏@handle.
- תמונות אנכיות ממלאות את המסך; תמונות לרוחב מוצגות כ"כרטיס" על רקע מטושטש.
- **כרטיס סיום** עם קריאה לפעולה ("בואו לטעום", "הזמנת מקום בלינק בביו").
- **מוזיקה**: רצועה אקראית מ-`assets/music/` (מוסיקה חופשית מזכויות שאתם מכניסים). אם התיקייה
  ריקה, הסוכן מסנתז פאד עדין כדי שלא יצא רילס שקט.
- **כיתוב + האשטגים** בעברית טבעית, לפי מה שבאמת יש בתמונות ולפי הערות שלכם ("היום מבצע על סלט קיסר").
- **פרסום אוטומטי** לרילס בשעה קבועה כל יום, עם אפשרות לאישור בטלגרם לפני הפרסום.

## התקנה מהירה

```bash
cd restaurant-reels-agent
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# ffmpeg: apt install ffmpeg  (או brew install ffmpeg). אם אין, משתמשים בבינארי של imageio-ffmpeg.
cp config.example.toml config.toml   # לערוך: שם המסעדה, handle, עיר, שעת פרסום
python -m reels_agent web            # ממשק בדפדפן: העלאת תמונות + מוזיקה + תצוגה מקדימה
python -m reels_agent demo           # רילס לדוגמה עם תמונות מזויפות -> output/<תאריך>/
python -m reels_agent check          # בודק ffmpeg, פונטים, אינסטגרם, אחסון, טלגרם
```

מומלץ להוריד פונט עברי יפה (למשל [Heebo](https://fonts.google.com/specimen/Heebo) או
[Assistant](https://fonts.google.com/specimen/Assistant)) ולשים את קובצי ה-TTF ב-`assets/fonts/`.
בלי זה משתמשים ב-DejaVu Sans, שתומך בעברית אבל פחות יפה.

## 🖥️ ממשק ווב: העלאה, מוזיקה ותצוגה מקדימה

הדרך הכי נוחה לנסות ולכוון את העיצוב לפני שמפעילים אוטומציה:

```bash
python -m reels_agent web        # http://127.0.0.1:5000
```

בדפדפן: גוררים תמונות (וקובעים את הסדר), בוחרים מוזיקה — רצועה מהספרייה, **קישור** לקובץ אודיו,
העלאת קובץ, או בלי מוזיקה — מכווננים שניות לתמונה ופריסה, ולוחצים "צור רילס". התצוגה המקדימה
מופיעה בנגן בגודל טלפון תוך שניות. אחר כך אפשר לערוך את שמות המנות, משפט הפתיחה, הסיום והכיתוב,
ללחוץ "רנדר מחדש עם העריכות", ולפרסם ישירות לאינסטגרם (אם הוגדרו טוקן ואחסון).

הערה על מוזיקה מקישור: קישור ישיר לקובץ (mp3/m4a/wav) עובד מיד. קישור לעמוד וידאו דורש
`pip install yt-dlp`, ובכל מקרה **באחריותכם לוודא שיש לכם זכויות לשימוש מסחרי** — אינסטגרם מורידה
רילסים עם מוזיקה לא מורשית. ה-API של אינסטגרם לא מאפשר לבחור צליל מהספרייה של אינסטגרם, לכן
המוזיקה מוטמעת בקובץ.

השרת מיועד להרצה מקומית בלבד (מאזין ל-127.0.0.1 ובלי אימות). לחשיפה ברשת פנימית:
`python -m reels_agent web --host 0.0.0.0`.

## שימוש יומי

### אפשרות א: תיקייה + cron
זורקים את התמונות של היום ל-`inbox/` (או `inbox/2026-09-04/`), ובשעה קבועה:
```bash
python -m reels_agent run            # כיתוב -> רילס -> העלאה -> פרסום -> העברה ל-archive/
python -m reels_agent run --dry-run  # רק לרנדר, בלי לפרסם
```
ראו `cron.example`.

### אפשרות ב: בוט טלגרם (מומלץ)
1. יוצרים בוט אצל [@BotFather](https://t.me/BotFather) ומקבלים טוקן.
2. מגלים את ה-chat id שלכם (שולחים הודעה לבוט ואז מריצים `daemon`; ה-id מופיע בלוג / בתשובת הבוט).
3. ב-`config.toml`:
   ```toml
   [telegram]
   enabled = true
   allowed_chat_ids = [123456789]
   require_approval = true
   ```
4. מריצים את הדמון:
   ```bash
   TELEGRAM_BOT_TOKEN=... python -m reels_agent daemon
   ```
מעכשיו שולחים לבוט תמונות מהטלפון במהלך היום (כדאי לשלוח "כקובץ" לאיכות מלאה). טקסט חופשי
שנשלח לבוט נשמר כהערות לכותב הכיתוב. בשעת הפרסום (`schedule.post_time`) הסוכן מרנדר, שולח
תצוגה מקדימה לטלגרם, ומחכה ל-`/approve` או `/skip`. `/post` מפרסם מיד, `/status` מציג מצב.

### Docker
```bash
mkdir -p data && cp config.example.toml data/config.toml && cp .env.example .env   # לערוך
docker compose up -d --build
```

## חיבור לאינסטגרם (פעם אחת)

ה-API של אינסטגרם מאפשר פרסום רילס רק ל**חשבון עסקי או Creator** שמקושר לדף פייסבוק.

1. הופכים את חשבון האינסטגרם לחשבון עסקי ומקשרים אותו לדף פייסבוק של המסעדה.
2. ב-[Meta for Developers](https://developers.facebook.com/) יוצרים אפליקציה ומוסיפים את המוצר
   **Instagram Graph API**.
3. ב-[Graph API Explorer](https://developers.facebook.com/tools/explorer/) מפיקים User Token עם ההרשאות
   `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`,
   ואז ממירים ל-**long-lived token** (תקף 60 יום; אפשר לרענן).
4. מוצאים את ה-Instagram Business Account ID:
   `GET /me/accounts?fields=instagram_business_account` → `IG_USER_ID`.
5. שמים `IG_USER_ID` ו-`IG_ACCESS_TOKEN` בסביבה או ב-`config.toml`, ומריצים `python -m reels_agent check`.

### אחסון (חובה לפרסום)
אינסטגרם **מורידה את הווידאו מ-URL ציבורי**, לכן צריך מקום לארח את ה-MP4 לכמה דקות:
- **S3 / Cloudflare R2 / Backblaze B2 / MinIO** — `kind = "s3"`. ברירת המחדל היא bucket פרטי עם
  presigned URL, כך שלא צריך לפתוח כלום לציבור.
- **תיקייה בשרת שכבר מוגש דרך HTTPS** — `kind = "static"`.

## הכיתוב עם Claude

עם `ANTHROPIC_API_KEY` בסביבה, הסוכן שולח את התמונות (מוקטנות) ל-`claude-opus-5` ומקבל JSON מובנה:
משפט פתיחה, שם ל**כל** תמונה לפי מה שרואים בה, כיתוב של 2–4 שורות, האשטגים ומשפט סיום.
בלי מפתח (או בתקלה) משתמשים בתבנית מ-`config.toml`, כך שרילס תמיד יוצא.
הסוכן משתמש ב-server-side refusal fallback של Anthropic כדי שבקשה שנדחית על ידי מסנן הבטיחות
לא תעצור את הפרסום היומי.

## פקודות

| פקודה | מה עושה |
|---|---|
| `run [--dry-run] [--no-publish] [--photos a.jpg b.jpg]` | הריצה היומית המלאה |
| `render` | רק רינדור, בלי פרסום ובלי ארכוב |
| `caption [--notes "..."]` | רק הכיתוב (JSON + טקסט) |
| `publish --video x.mp4 --caption caption.txt` | פרסום קובץ קיים |
| `demo [--ai]` | רילס לדוגמה עם תמונות מזויפות |
| `web [--port 5000]` | ממשק דפדפן: העלאת תמונות, מוזיקה, תצוגה מקדימה, עריכה ופרסום |
| `daemon` | טלגרם + פרסום יומי מתוזמן |
| `check` | בדיקת הגדרות |

## מבנה
```
reels_agent/
  intake.py    תיקיית inbox + בוט טלגרם (/post /approve /skip /status)
  caption.py   Claude vision -> hook, dish_labels, caption, hashtags (structured output)
  render.py    Pillow: כרטיסים ותוויות בעברית (RTL)  |  ffmpeg: zoompan + xfade + מוזיקה
  music.py     בחירת רצועה / סינתוז פאד
  storage.py   S3 / תיקייה סטטית -> URL ציבורי
  publish.py   Instagram Graph API: container -> poll -> publish
  pipeline.py  הריצה היומית, ארכוב, יומן ב-state/posts.jsonl
  web.py       ממשק דפדפן מקומי (Flask): העלאה, תצוגה מקדימה, עריכה, פרסום
  cli.py       פקודות + דמון מתוזמן
```

בדיקות: `python -m pytest tests`
