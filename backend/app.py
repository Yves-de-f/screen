from flask import Flask, render_template, request, jsonify
import os
import sys

# 取得 app.py 的所在目錄
base_dir = os.path.dirname(os.path.abspath(__file__))

# 指定 templates 資料夾在 backend 的上一層
template_dir = os.path.join(base_dir, '../templates')
static_dir = os.path.join(base_dir, '../static')

# 建立 Flask app，指定模板與 static 目錄
app = Flask(__name__, template_folder=template_dir, static_folder=static_dir)

# 匯入 ssh_utils.py (同樣位於 backend/)
sys.path.append(base_dir)
from ssh_utils import run_ssh_command

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/run', methods=['POST'])
def api_run():
    data = request.json
    command = data.get('command')
    output = run_ssh_command(command)
    print(f"收到指令: {command}")
    print(f"輸出結果: {output}")
    return jsonify({"output": output})

if __name__ == '__main__':
    app.run(debug=True)
