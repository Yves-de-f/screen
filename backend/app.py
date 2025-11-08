import os
import pty
import signal
import jwt
import subprocess # 【【【 新增 】】】
import shlex    # 【【【 新增 】】】
import tempfile # 【【【 新增 】】】
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, render_template, request, jsonify, redirect, url_for, make_response
from flask_socketio import SocketIO
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__, template_folder='../templates', static_folder='../static')
app.config['SECRET_KEY'] = 'a_very_secret_key'  # IMPORTANT: Change this in a real application
socketio = SocketIO(app, async_mode='threading')

# --- User Store (with hashed passwords) ---
USERS = {
    "yves": generate_password_hash("123")
}

# --- JWT Helper Functions ---
# (此區塊不變 ... generate_token, token_required)
def generate_token(username):
    """Generates a JWT for a given user."""
    payload = {
        'exp': datetime.utcnow() + timedelta(hours=1),
        'iat': datetime.utcnow(),
        'sub': username
    }
    return jwt.encode(payload, app.config['SECRET_KEY'], algorithm='HS256')

def token_required(f):
    """Decorator to protect routes. Now expects token to be handled by client."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.cookies.get('token')
        if not token:
            return redirect(url_for('login'))
        try:
            jwt.decode(token, app.config['SECRET_KEY'], algorithms=['HS256'])
        except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
            return redirect(url_for('login', error='Invalid or expired token.'))
        return f(*args, **kwargs)
    return decorated

# --- Routes ---
# (此區塊不變 ... /login, /logout)
@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        
        user_hash = USERS.get(username)

        if user_hash and check_password_hash(user_hash, password):
            token = generate_token(username)
            resp = jsonify({'token': token})
            resp.set_cookie('token', token, httponly=True, samesite='Lax')
            return resp
        
        return jsonify({'error': 'Invalid credentials'}), 401

    error = request.args.get('error')
    return render_template('login.html', error=error)

@app.route('/logout')
def logout():
    """Clears the token cookie and redirects to login."""
    resp = make_response(redirect(url_for('login')))
    resp.set_cookie('token', '', expires=0)
    return resp

@app.route('/')
@token_required
def index():
    """Serves the main SSH terminal page."""
    # (已在安全審查中修復)
    return render_template('index.html')

# --- SSH Session Management (重構開始) ---

# Dictionary to map session IDs to their SSH process info
ssh_sessions = {}

ALLOWED_HOSTS = {
    "twnia3.nchc.org.tw",
    "其他節點1",
}

def read_and_forward_ssh_output(sid):
    """
    (此函數完全不變)
    """
    print(f"Read task starting for {sid}...")
    try:
        fd = ssh_sessions[sid]['fd']
    except KeyError:
        print(f"Read task for {sid} started, but session already gone.")
        return

    while True:
        # 檢查 session 是否還存在，如果不存在 (已被 cleanup) 就退出
        if sid not in ssh_sessions:
            print(f"Read task for {sid} stopping (session removed).")
            break
        
        try:
            output = os.read(fd, 1024)
            if output:
                socketio.emit('ssh_output', output.decode(errors='replace'), to=sid)
            else:
                # 讀到 0 bytes，表示 SSH 進程正常結束 (例如 'exit')
                print(f"Read task for {sid} got EOF (process exited).")
                break
        except (OSError, KeyError):
            # OSError: FD 被 cleanup_session 關閉
            # KeyError: Session 被 cleanup_session 移除
            print(f"Read task for {sid} stopping (OS/KeyError).")
            break
    
    # 任務結束，請求清理 (以防萬一)
    print(f"Read task for {sid} finished. Requesting cleanup.")
    cleanup_session(sid, from_read_task=True)

def cleanup_session(sid, from_read_task=False):
    """
    (此函數完全不變)
    """
    session = ssh_sessions.pop(sid, None)
    
    if not session:
        return

    pid = session.get('pid')
    fd = session.get('fd')
    ctrl_path = session.get('ctrl_path')
    
    print(f"Cleanup: Performing cleanup for {sid} (PID {pid})")
    
    if ctrl_path:
        try:
            exit_cmd = ['ssh', '-S', ctrl_path, '-O', 'exit', 'ignored']
            subprocess.run(exit_cmd, timeout=5)
            print(f"Cleanup: Closed master connection for {sid}")
            if os.path.exists(ctrl_path):
                 os.remove(ctrl_path) # 清理 socket 檔案
        except Exception as e:
            print(f"Cleanup: Error closing master connection: {e}")

    try:
        os.write(fd, b'\x03') # 仍然發送 Ctrl+C
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass
        
    print(f"Cleanup: Successfully cleaned up {sid} (PID {pid})")

    if from_read_task:
        msg = '\r\n[Connection closed by remote]\r/n'
    else:
        msg = '\r\n[Connection closed by user]\r\n'
        
    # 仍然發送訊號，這是最好的情況
    socketio.emit('ssh_output', msg, to=sid)

@socketio.on('connect')
def on_connect():
    """(此函數完全不變)"""
    token = request.cookies.get('token') 
    if not token:
        print("Client connected without token. Disconnecting.")
        return False
    try:
        payload = jwt.decode(token, app.config['SECRET_KEY'], algorithms=['HS256'])
        username = payload['sub']
        print(f"Client '{username}' connected with SID: {request.sid}")
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        print("Client connected with invalid token. Disconnecting.")
        return False

@socketio.on('disconnect')
def on_disconnect():
    """
    (此函數完全不變)
    """
    sid = request.sid
    print(f"Client {sid} disconnected (SocketIO).")
    # 這是一個「硬」斷線，我們必須清理
    cleanup_session(sid, from_read_task=False)

@socketio.on('ssh_connect')
def ssh_connect(data):
    """(此函數完全不變)"""
    sid = request.sid
    if sid in ssh_sessions:
        socketio.emit('ssh_output', '\r\n[Already connected]\r\n', to=sid)
        return

    host = data.get('host')
    user = data.get('user')

    if not host or not user:
        socketio.emit('ssh_output', '\r\n[Error: Host and user are required]\r\n', to=sid)
        return

    if host not in ALLOWED_HOSTS:
        socketio.emit('ssh_output', f"\r\n[Error: Host '{host}' is not allowed]\r\n", to=sid)
        return

    # 【【【 新增：為 Control Socket 建立一個唯一的暫存檔案路徑 】】】
    try:
        # 建立一個安全的暫存檔案，我們只使用它的「檔名」
        with tempfile.NamedTemporaryFile(delete=True) as tmp_file:
            ctrl_path = tmp_file.name
        # 建立完後檔案會被刪除，我們只取用這個「不會重複」的路徑
    except Exception as e:
        socketio.emit('ssh_output', f'\r\n[Error creating temp socket path: {e}]\r\n', to=sid)
        return

    # 【【【 修改：為 ssh 指令加入 -M 和 -S 參數 】】】
    command = [
        'ssh', 
        '-M',                 # 建立 Master connection
        '-S', ctrl_path,      # 指定 Control Socket 路徑
        f'{user}@{host}'
    ]

    try:
        pid, fd = pty.fork()
    except OSError as e:
        socketio.emit('ssh_output', f'\r\n[Error forking pty: {e}]\r\n', to=sid)
        return

    if pid == 0:  # Child process
        os.execvp(command[0], command)
    else:  # Parent process
        print(f"Started SSH process with PID {pid} for SID {sid}")
        print(f"Control Socket at: {ctrl_path}")
        
        # 【【【 修改：儲存更多 session 資訊 】】】
        ssh_sessions[sid] = {
            'pid': pid, 
            'fd': fd,
            'user': user,     # 儲存 user
            'host': host,     # 儲存 host
            'ctrl_path': ctrl_path # 儲存 ctrl_path
        }
        socketio.start_background_task(target=read_and_forward_ssh_output, sid=sid)

@socketio.on('ssh_input')
def ssh_input(data):
    """(此函數完全不變)"""
    # 使用 .get() 來安全地獲取 session
    # 如果 session 剛好被清理，.get() 會返回 None，就不會執行
    session = ssh_sessions.get(request.sid)
    if session:
        try:
            os.write(session['fd'], data['input'].encode())
        except OSError:
            # FD 可能已被關閉，session 正在死亡。
            # read_task 會處理後續清理。
            pass

@socketio.on('ssh_disconnect')
def ssh_disconnect():
    """
    (此函數完全不V變)
    """
    sid = request.sid
    print(f"Client {sid} requested SSH disconnect.")
    # 呼叫唯一的清理函數
    cleanup_session(sid, from_read_task=False)

# --- 【【【 全新功能：TMUX 控制器 】】】 ---

def run_ssh_control_command(sid, tmux_command):
    """
    (此函數完全不變)
    """
    session = ssh_sessions.get(sid)
    if not session:
        return {"error": "Session not found"}

    ctrl_path = session['ctrl_path']
    if not os.path.exists(ctrl_path):
         return {"error": f"Control socket {ctrl_path} not found"}

    # -o 'BatchMode=yes' 確保它不會嘗試任何互動式驗證
    ssh_cmd = [
        'ssh',
        '-S', ctrl_path,
        '-o', 'BatchMode=yes',
        'ignored_host', # Host is ignored, we use the master connection
        tmux_command    # 
    ]

    try:
        # 我們使用 Popen 並 communicate 來處理 timeout 和 stdout/stderr
        process = subprocess.Popen(ssh_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout, stderr = process.communicate(timeout=10) # 10 秒 timeout
        
        if process.returncode != 0:
            return {"error": stderr.strip() or f"Command failed with code {process.returncode}"}
        
        return {"output": stdout.strip()}
        
    except subprocess.TimeoutExpired:
        process.kill()
        return {"error": "SSH control command timed out"}
    except Exception as e:
        return {"error": f"SSH control command exception: {e}"}

@socketio.on('tmux_control')
def tmux_control(data):
    """
    【【【 此函數已更新 】】】
    處理來自前端的所有 tmux GUI 指令
    """
    sid = request.sid
    action = data.get('action')
    
    if not action:
        return

    # 【【【【【【 關鍵修復 】】】】】】
    # 確保伺服器啟動「並且」至少有一個會話存在
    # 1. 啟動伺服器 (如果已在運作則無害)
    # 2. 檢查是否有會話 (has-session)，隱藏 "no server" 錯誤
    # 3. 如果 (||) 檢查失敗 (沒有會話)，則建立一個新的分離 (detached) 會話
    # 4. 只有在 (&&) 上述都成功後，才執行後續指令
    tmux_base_cmd = "tmux start-server ; (tmux has-session 2>/dev/null || tmux new-session -d) && "
    tmux_command = ""

    if action == 'list':
        # -F 指定格式： 
        # 0:bash (window_id:window_name)
        tmux_command = "tmux list-windows -F '#{window_id}:#{window_name}'"
    
    elif action == 'new':
        name = data.get('name', '').strip() # 獲取名稱，並去除空白

        # 【【【 數字命名邏輯 (不變) 】】】
        if not name:
            # 1. 執行 list-windows 獲取現有名稱
            list_cmd = tmux_base_cmd + "tmux list-windows -F '#{window_name}'"
            list_result = run_ssh_control_command(sid, list_cmd)
            
            existing_names = []
            if "output" in list_result and list_result['output']:
                existing_names = list_result['output'].split('\n')
                
            # 2. 找出所有「數字名稱」
            numeric_names = set()
            for n in existing_names:
                if n.isdigit():
                    numeric_names.add(int(n))
            
            # 3. 找出下一個可用的數字 (從 0 開始)
            new_name_int = 0
            while new_name_int in numeric_names:
                new_name_int += 1
            
            name = str(new_name_int) # 找到了！
        
        # 繼續執行 new-window 指令
        tmux_command = f"tmux new-window -n {shlex.quote(name)} -d -P -F '#{{window_id}}:#{{window_name}}'"
        
    elif action == 'select':
        target = data.get('target')
        if not target:
            return
        tmux_command = f"tmux select-window -t {shlex.quote(target)}"
        
    else:
        return # Unknown action

    # 【【【 修改：組合指令 】】】
    full_command = tmux_base_cmd + tmux_command
    result = run_ssh_control_command(sid, full_command) # 執行組合後的指令

    if "error" in result:
        # 【【【 修改：過濾掉良性的 "no server" 錯誤 】】】
        # (雖然 base_cmd 應該已處理，但多一層保險)
        err_msg = result['error']
        if "no server" in err_msg or "no session" in err_msg:
             # 這是 base_cmd 剛啟動伺服器時的正常情況，我們重試 list
             if action != 'list': # 避免無限迴圈
                 tmux_control({'action': 'list'})
             return
        
        socketio.emit('ssh_output', f"\r\n[TMUX Error: {err_msg}]\r\n", to=sid)
        return

    # 如果是 list, 回傳列表
    if action == 'list':
        windows = []
        if result['output']:
            try:
                for line in result['output'].split('\n'):
                    parts = line.split(':', 1)
                    if len(parts) == 2:
                        windows.append({"id": parts[0], "name": parts[1]})
            except Exception as e:
                socketio.emit('ssh_output', f"\r\n[TMUX Parse Error: {e}]\r\n", to=sid)
        
        # 發送一個新的事件來更新 UI
        socketio.emit('tmux_update', {"windows": windows}, to=sid)

    # 如果是 new, 執行 list 來回傳最新列表
    elif action == 'new':
        socketio.emit('ssh_output', f"\r\n[TMUX: Created {result.get('output')}]\r\n", to=sid)
        # 建立後，自動刷新列表
        tmux_control({'action': 'list'}) # 遞迴呼叫
        
    # 如果是 select, 什麼都不用做，因為 PTY 會自動更新 (理論上)
    # (但 tmux 的 select-window 不一定會觸發 pty 刷新，所以我們也 list 一下)
    elif action == 'select':
        # 選中後，也刷新列表 (以防萬一)
        tmux_control({'action': 'list'})
        
if __name__ == '__main__':
    print("Starting SSH Web Terminal server on http://0.0.0.0:5500")
    socketio.run(app, host='0.0.0.0', port=5500, debug=True)