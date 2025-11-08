# GUI Project (Flask + HTML/CSS/JS)

## 安裝與執行

```bash
python3 -m venv venv
source venv/bin/activate  # macOS/Linux
pip install -r requirements.txt
python backend/app.py
```

開啟瀏覽器: http://127.0.0.1:5500

## 專案結構

```
Projects/
├───.gitignore
├───README.md
├───requirements.txt
├───.git/...
├───.venv/...
├───backend/
│   ├───app.py
│   ├───ssh_utils.py
│   └───__pycache__/
│       └───ssh_utils.cpython-314.pyc
├───static/
│   ├───css/
│   │   └───style.css
│   └───js/
│       ├───login.js
│       └───script.js
└───templates/
    ├───index.html
    └───login.html
```