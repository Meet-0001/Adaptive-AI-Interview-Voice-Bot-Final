FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    gcc \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir --upgrade pip setuptools wheel pkg_resources || \
    pip install --no-cache-dir --upgrade pip setuptools wheel

RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir flask==3.0.3 flask-cors==4.0.1 requests==2.32.3 edge-tts==6.1.12

RUN pip install --no-cache-dir git+https://github.com/openai/whisper.git

COPY . .

RUN mkdir -p db

EXPOSE 5002

CMD ["python", "app.py"]