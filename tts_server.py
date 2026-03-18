from flask import Flask, request, send_file
import asyncio, edge_tts, tempfile

app = Flask(__name__)

@app.route("/tts", methods=["POST"])
def tts():
    text = request.json.get("text", "")
    tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
    tmp.close()
    async def go():
        await edge_tts.Communicate(text, "en-US-GuyNeural").save(tmp.name)
    asyncio.run(go())
    return send_file(tmp.name, mimetype="audio/mpeg")

if __name__ == "__main__":
    print("TTS Server running on port 5003")
    app.run(host="0.0.0.0", port=5003)