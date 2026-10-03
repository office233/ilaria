# Swypik AI Worker

Minimal Python scaffold for future video AI jobs: captions, tagging, and moderation.

The worker package currently provides:

- `AiJob` payload parsing for Redis Streams style jobs;
- `AiProcessor` task routing for registered handlers;
- explicit unsupported-task results so missing AI integrations fail predictably.

## Job Payload

Future Redis Stream entries can use either fields or a JSON `payload` field shaped like:

```json
{
  "job_id": "ai_123",
  "asset_id": "asset_456",
  "media_key": "videos/asset_456/master.m3u8",
  "tasks": ["captions", "tags", "moderation"],
  "metadata": {
    "language": "ro"
  }
}
```

## Local Setup

```powershell
cd E:\Swypik\swypik\app\workers\ai-worker
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pytest
```
