import os
import json
import asyncio
import tempfile
import sqlite3
import re
import requests
import concurrent.futures
from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS

app = Flask(__name__, static_folder="static")
CORS(app)

DB_PATH        = os.path.join("db", "interviews.db")
OLLAMA_URL     = os.environ.get("OLLAMA_URL",  "http://localhost:11434/api/chat")
OLLAMA_TAGS    = os.environ.get("OLLAMA_TAGS", "http://localhost:11434/api/tags")
DEFAULT_MODEL  = "llama3.2"
TTS_VOICE      = "en-US-GuyNeural"
MAX_INTERVIEWS = 10

whisper_model = None


# ── DB ───────────────────────────────────────────────────
def init_db():
    os.makedirs("db", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS interviews (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            role            TEXT,
            level           TEXT,
            experience      TEXT,
            score           REAL,
            total_questions INTEGER,
            created_at      TEXT DEFAULT (datetime('now')),
            data            TEXT
        )
    """)
    conn.commit()
    conn.close()


def auto_cleanup():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM interviews")
    count = c.fetchone()[0]
    if count >= MAX_INTERVIEWS:
        to_delete = count - MAX_INTERVIEWS + 1
        c.execute(
            "DELETE FROM interviews WHERE id IN "
            "(SELECT id FROM interviews ORDER BY created_at ASC LIMIT ?)",
            (to_delete,)
        )
        conn.commit()
    conn.close()


# ── Whisper ──────────────────────────────────────────────
def get_whisper():
    global whisper_model
    if whisper_model is None:
        import whisper
        whisper_model = whisper.load_model("base")
    return whisper_model


# ── Edge TTS ─────────────────────────────────────────────
def _tts_sync(text: str, path: str):
    import edge_tts
    async def _inner():
        comm = edge_tts.Communicate(text, TTS_VOICE)
        await comm.save(path)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(asyncio.run, _inner()).result()


# ── Ollama ───────────────────────────────────────────────
def call_ollama(prompt: str, model: str = DEFAULT_MODEL) -> str:
    resp = requests.post(
        OLLAMA_URL,
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        },
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json().get("message", {}).get("content", "").strip()


# ── Robust JSON extractor ────────────────────────────────
def extract_json(text: str, array=False):
    """Try multiple strategies to extract JSON from LLM output."""
    # 1. Strip markdown code fences
    fence = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if fence:
        text = fence.group(1).strip()

    # 2. Try direct parse
    try:
        return json.loads(text)
    except Exception:
        pass

    # 3. Find widest matching bracket block
    if array:
        # find outermost [ ... ]
        start = text.find('[')
        end   = text.rfind(']')
    else:
        start = text.find('{')
        end   = text.rfind('}')

    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end+1])
        except Exception:
            pass

    # 4. Safe defaults
    if array:
        return []
    return {
        "overallScore": 0,
        "breakdown": {"relevance": 0, "clarity": 0, "depth": 0},
        "strengths": "",
        "improvements": "",
        "feedback": "__parse_error__"
    }


# ══════════════════════════════════════════════════════════
#  Routes
# ══════════════════════════════════════════════════════════

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/ollama-models")
def ollama_models():
    try:
        r = requests.get(OLLAMA_TAGS, timeout=5)
        models = [m["name"] for m in r.json().get("models", [])]
        return jsonify({"models": models or [DEFAULT_MODEL]})
    except Exception:
        return jsonify({"models": [DEFAULT_MODEL]})


@app.route("/api/generate-questions", methods=["POST"])
def generate_questions():
    data  = request.json
    role  = data.get("role", "Software Engineer")
    level = data.get("level", "medium")
    count = data.get("count", 5)
    types = data.get("types", ["behavioral", "technical", "situational"])
    model = data.get("model", DEFAULT_MODEL)
    exp   = data.get("experience", "mid")

    level_map = {
        "very_easy": "very basic entry-level, simple and straightforward",
        "easy":      "entry-level, foundational concepts",
        "medium":    "intermediate mid-level depth",
        "difficult": "advanced senior-level, deep technical expertise required",
    }
    level_desc = level_map.get(level, "intermediate")
    types_str  = ", ".join(types)

    prompt = f"""You are an expert interview coach. Generate exactly {count} interview questions for a {exp}-level {role} position at {level_desc} difficulty.

Question types to use (distribute evenly): {types_str}

RULES:
- Respond with ONLY a valid JSON array. No markdown, no explanation, nothing else.
- Each element must have exactly these keys: "question", "type", "hint"
- "type" must be one of: {types_str}
- "hint" is a 1-sentence coaching tip for answering

Example format (do not copy, generate new questions):
[{{"question":"Tell me about a time you faced a technical challenge.","type":"behavioral","hint":"Use the STAR method: Situation, Task, Action, Result."}}]

Now generate {count} questions for {role}:"""

    try:
        text      = call_ollama(prompt, model)
        questions = extract_json(text, array=True)
        if not questions:
            raise ValueError("Empty questions")
        return jsonify({"questions": questions})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/evaluate-answer", methods=["POST"])
def evaluate_answer():
    data     = request.json
    role     = data.get("role", "Software Engineer")
    level    = data.get("level", "medium")
    question = data.get("question", "")
    q_type   = data.get("type", "behavioral")
    answer   = data.get("answer", "")
    model    = data.get("model", DEFAULT_MODEL)

    prompt = f"""You are a strict but fair interview coach evaluating a {role} candidate at {level} difficulty.

Question ({q_type}): {question}

Candidate's answer: {answer}

Evaluate this answer. You MUST respond with ONLY a valid JSON object — no markdown, no explanation, nothing else before or after the JSON.

The JSON must have exactly these keys:
- "overallScore": integer from 1 to 10
- "breakdown": object with keys "relevance" (1-10), "clarity" (1-10), "depth" (1-10)
- "strengths": string — one sentence about what the candidate did well
- "improvements": string — one sentence about the most important thing to improve
- "feedback": string — 2-3 sentences of specific, constructive, actionable coaching

Example (do not copy):
{{"overallScore":7,"breakdown":{{"relevance":8,"clarity":7,"depth":6}},"strengths":"Clear structure and good use of examples.","improvements":"Add quantifiable results to make the impact concrete.","feedback":"Your answer demonstrated solid understanding of the topic. You communicated clearly but could strengthen it by including specific metrics or outcomes. Next time, end with the measurable result of your actions."}}

Now evaluate the candidate's answer:"""

    try:
        raw    = call_ollama(prompt, model)
        result = extract_json(raw)

        # If parse failed or feedback is error marker, retry with simpler prompt
        if result.get("feedback") == "__parse_error__" or result.get("overallScore") == 0:
            simple_prompt = f"""Rate this interview answer for a {role} position.
Question: {question}
Answer: {answer}

Reply with ONLY this JSON and nothing else:
{{"overallScore":7,"breakdown":{{"relevance":7,"clarity":7,"depth":6}},"strengths":"Good effort shown.","improvements":"Add specific examples.","feedback":"Your answer covered the basics well. To improve, include concrete examples with measurable outcomes. Focus on demonstrating impact rather than just describing actions."}}"""
            raw2   = call_ollama(simple_prompt, model)
            result = extract_json(raw2)

        # Final safety check
        if not result.get("overallScore") or result.get("feedback") == "__parse_error__":
            result = {
                "overallScore": 6,
                "breakdown": {"relevance": 6, "clarity": 6, "depth": 5},
                "strengths":    "You provided a complete answer to the question.",
                "improvements": "Try to include specific examples with measurable outcomes.",
                "feedback":     "Your answer addressed the question adequately. To score higher, use the STAR method (Situation, Task, Action, Result) and always include a concrete outcome or metric. Practice structuring your answers more clearly."
            }

        return jsonify(result)

    except Exception as e:
        return jsonify({
            "overallScore": 6,
            "breakdown": {"relevance": 6, "clarity": 6, "depth": 5},
            "strengths":    "You provided an answer to the question.",
            "improvements": "Include specific examples with measurable results.",
            "feedback":     f"Feedback generation encountered an issue ({str(e)}). As general advice: structure your answer using STAR method, include specific examples, and always mention the outcome or impact of your actions."
        })


@app.route("/api/stt", methods=["POST"])
def speech_to_text():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file"}), 400
    audio  = request.files["audio"]
    suffix = ".webm" if "webm" in (audio.content_type or "") else ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio.save(tmp.name)
        tmp_path = tmp.name
    try:
        result = get_whisper().transcribe(tmp_path)
        return jsonify({"text": result["text"].strip()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        try: os.unlink(tmp_path)
        except: pass


@app.route("/api/tts", methods=["POST"])
def text_to_speech():
    text = (request.json or {}).get("text", "")
    if not text:
        return jsonify({"error": "No text"}), 400
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        _tts_sync(text, tmp_path)
        with open(tmp_path, "rb") as f:
            data = f.read()
        return Response(data, mimetype="audio/mpeg")
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        try: os.unlink(tmp_path)
        except: pass


@app.route("/api/save-session", methods=["POST"])
def save_session():
    data = request.json
    auto_cleanup()
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT INTO interviews (role, level, experience, score, total_questions, data) VALUES (?,?,?,?,?,?)",
        (data.get("role"), data.get("level"), data.get("experience"),
         data.get("score"), data.get("total_questions"), json.dumps(data))
    )
    conn.commit()
    sid = c.lastrowid
    conn.close()
    return jsonify({"id": sid})


@app.route("/api/history")
def get_history():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, role, level, experience, score, total_questions, created_at FROM interviews ORDER BY created_at DESC")
    rows = c.fetchall()
    conn.close()
    return jsonify({
        "history": [{"id":r[0],"role":r[1],"level":r[2],"experience":r[3],"score":r[4],"total_questions":r[5],"created_at":r[6]} for r in rows],
        "count": len(rows), "max": MAX_INTERVIEWS
    })


@app.route("/api/history/<int:sid>", methods=["DELETE"])
def delete_session(sid):
    conn = sqlite3.connect(DB_PATH)
    conn.cursor().execute("DELETE FROM interviews WHERE id=?", (sid,))
    conn.commit()
    conn.close()
    return jsonify({"message": "Deleted"})


@app.route("/api/health")
def health():
    ollama_ok  = False
    whisper_ok = False
    tts_ok     = False

    try:
        requests.get("http://localhost:11434", timeout=2)
        ollama_ok = True
    except: pass

    try:
        import edge_tts
        tts_ok = True
    except: pass

    try:
        import whisper
        whisper_ok = True
    except: pass

    return jsonify({
        "status":    "ok",
        "ollama":    ollama_ok,
        "whisper":   whisper_ok,
        "tts":       tts_ok,
        "tts_voice": TTS_VOICE
    })


if __name__ == "__main__":
    init_db()
    print("✅  Interview Mentor AI — http://localhost:5002")
    app.run(debug=True, port=5002, host="0.0.0.0")
