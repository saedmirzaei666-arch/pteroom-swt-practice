import json
import os
import whisper

print("در حال بارگذاری مدل هوش مصنوعی Whisper...")
# مدل base برای سرعت بالا و دقت مناسب در انگلیسی عالی است
model = whisper.load_model("base")

audio_dir = "wfd_audios"
json_path = "data/wfd_questions.json"

# خواندن فایل JSON موجود
questions = []
if os.path.exists(json_path):
  with open(json_path, "r", encoding="utf-8") as f:
    try:
      questions = json.load(f)
    except:
      questions = []

q_dict = {str(q["id"]): q for q in questions}

# اسکن پوشه صوتی
if os.path.exists(audio_dir):
  for filename in os.listdir(audio_dir):
    if filename.endswith(".mp3"):
      file_id = filename.replace(".mp3", "")
      audio_path = os.path.join(audio_dir, filename)

      # بررسی اینکه آیا این فایل متن ندارد یا متن پیش‌فرض دارد
      if file_id not in q_dict or "Type the exact sentence" in q_dict[file_id].get("text", "") or not q_dict[file_id].get("text"):
        print(f"در حال پردازش و استخراج متن برای فایل: {filename} ...")
        result = model.transcribe(audio_path)
        transcribed_text = result["text"].strip()

        if file_id in q_dict:
          q_dict[file_id]["text"] = transcribed_text
        else:
          new_q = {
              "id": int(file_id) if file_id.isdigit() else file_id,
              "title": f"WFD #{file_id}",
              "audioUrl": filename,
              "text": transcribed_text,
              "isPrediction": True,
          }
          questions.append(new_q)

# مرتب‌سازی بر اساس آیدی سوالات
questions.sort(key=lambda x: int(x["id"]) if str(x["id"]).isdigit() else 0)

# ذخیره نهایی در فایل JSON
with open(json_path, "w", encoding="utf-8") as f:
  json.dump(questions, f, ensure_ascii=False, indent=2)

print("عملیات با موفقیت انجام شد! متن همه فایل‌ها استخراج و در JSON ذخیره شد.")