"""
ml/classify.py

Lightweight inference script called by Node.js via child_process.
Takes title and description as command-line args, prints the category.

Usage:
  python3 ml/classify.py "Senior Software Engineer" "We are looking for..."
"""
import sys, joblib, os

model_path = os.path.join(os.path.dirname(__file__), 'model.joblib')
model = joblib.load(model_path)

title = sys.argv[1] if len(sys.argv) > 1 else ''
desc  = sys.argv[2] if len(sys.argv) > 2 else ''
text  = f"{title} {title} {title} {desc[:400]}"

print(model.predict([text])[0])
